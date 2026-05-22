import { NextResponse, type NextRequest } from 'next/server';
import { insertWebhookLog, upsertContact, upsertConversation, insertMessage, incrementConversationCounts } from '@/lib/db/queries';
import { decryptCredentials } from '@/lib/credentials';
import { fetchNewMessages, parseGmailMessage } from '@/lib/adapters/email/gmail';
import { forwardInboundToSupport } from '@/lib/forwarders/support';
import { getServiceClient } from '@/lib/db/supabase';

type ChannelAccountRow = {
  id: string;
  company_id: string;
  channel: string;
  display_name: string | null;
  handle: string | null;
  delivery_target: string | null;
  credentials: string;
  is_active: boolean;
  last_webhook_at: string | null;
};

/**
 * POST: Email push notification webhook.
 *
 * Pub/Sub pushes here with a payload identifying which Gmail mailbox
 * has new mail. We look up EVERY channel_accounts row matching that
 * mailbox (regardless of the URL's :companyId slug) — a single mailbox
 * can be connected by both BPO and Support, and both need the new
 * messages. Each account is processed independently; one failure
 * (e.g. a row with a stale/missing refresh_token) doesn't halt the
 * others. We still ack 200 to Pub/Sub so it doesn't retry-storm.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ companyId: string }> },
) {
  const { companyId } = await params;

  const body = await req.json();
  insertWebhookLog('email', companyId, body).catch(() => {});

  // Decode Pub/Sub push notification
  const messageData = body.message?.data;
  if (!messageData) {
    return new Response('OK', { status: 200 });
  }

  let decoded: { emailAddress?: string; historyId?: string };
  try {
    decoded = JSON.parse(Buffer.from(messageData, 'base64').toString('utf8'));
  } catch {
    return new Response('OK', { status: 200 });
  }
  const targetEmail = decoded.emailAddress;
  const historyId = decoded.historyId;
  if (!targetEmail || !historyId) {
    return new Response('OK', { status: 200 });
  }

  // Look up every account watching this mailbox. We fetch all active
  // email accounts and filter in JS by handle/display_name: PostgREST's
  // `.or()` URL-encoding mangles addresses containing '@' so the
  // server-side filter would silently miss valid rows. The email
  // accounts table is small enough that this is fine.
  const supabase = getServiceClient();
  const { data: allEmailAccounts, error: fetchErr } = await supabase
    .from('channel_accounts')
    .select('id, company_id, channel, display_name, handle, delivery_target, credentials, is_active, last_webhook_at')
    .eq('channel', 'email')
    .eq('is_active', true);

  if (fetchErr) {
    console.error('Webhook account lookup failed:', fetchErr.message);
    return new Response('OK', { status: 200 });
  }
  const accounts = (allEmailAccounts ?? []).filter(
    (a) => a.handle === targetEmail || a.display_name === targetEmail,
  );
  console.info(
    `[email-webhook] mailbox=${targetEmail} historyId=${historyId} matched=${accounts.length}/${allEmailAccounts?.length ?? 0} → ${accounts
      .map((a) => `${a.company_id}/${a.delivery_target}`)
      .join(',')}`,
  );
  if (accounts.length === 0) {
    console.warn(`[email-webhook] no account matched mailbox ${targetEmail}`);
    return new Response('OK', { status: 200 });
  }

  let processedTotal = 0;

  for (const account of accounts as ChannelAccountRow[]) {
    try {
      const creds = decryptCredentials(account.credentials);
      if (creds.provider !== 'gmail') continue;
      const refreshToken = typeof creds.refresh_token === 'string' ? creds.refresh_token : '';
      if (!refreshToken) {
        console.warn(
          `[email-webhook] account ${account.id} (${account.company_id}/${account.delivery_target}) missing refresh_token — skipping`,
        );
        continue;
      }

      const gmailMessages = await fetchNewMessages(refreshToken, historyId);
      console.info(
        `[email-webhook] account ${account.id} (${account.company_id}/${account.delivery_target}) fetched ${gmailMessages.length} message(s) since historyId=${historyId}`,
      );

      for (const gmailMsg of gmailMessages) {
        const normalized = parseGmailMessage(gmailMsg, account.company_id);
        if (!normalized || normalized.sender_role === 'system') continue;
        // Skip echo of our own outbound sends
        if (normalized.channel_sender_id === creds.email_address) continue;

        const contactId = await upsertContact(
          account.company_id,
          'email',
          normalized.channel_sender_id,
          normalized.sender_name,
          null,
        );

        const conversationId = await upsertConversation(
          account.company_id,
          'email',
          contactId,
          account.id,
          normalized.channel_thread_id,
          normalized.text_body?.slice(0, 200) ?? null,
          normalized.subject ?? null,
        );

        const { isDuplicate } = await insertMessage(conversationId, normalized);
        if (!isDuplicate) {
          processedTotal++;
          await incrementConversationCounts(conversationId);
          forwardInboundToSupport({ account, msg: normalized, conversationId });
        }
      }

      // First-webhook detection per-account.
      if (gmailMessages.length > 0 && !account.last_webhook_at) {
        supabase
          .from('channel_accounts')
          .update({ last_webhook_at: new Date().toISOString() })
          .eq('id', account.id)
          .then(() => {});
      }
    } catch (err) {
      console.error(
        `[email-webhook] account ${account.id} (${account.company_id}/${account.delivery_target}) failed:`,
        err,
      );
      // continue with next account — don't let one bad row poison the others
    }
  }

  return NextResponse.json({ processed: processedTotal, accounts: accounts.length });
}
