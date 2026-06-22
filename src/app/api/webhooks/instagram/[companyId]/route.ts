import { type NextRequest } from 'next/server';
import { instagramInbound } from '@/lib/adapters/instagram';
import {
  getChannelAccount,
  insertWebhookLog,
  upsertContact,
  upsertConversation,
  insertMessage,
  bumpConversation,
} from '@/lib/db/queries';
import { getServiceClient } from '@/lib/db/supabase';
import { decryptCredentials } from '@/lib/credentials';
import { forwardInboundToSupport } from '@/lib/forwarders/support';

/** GET: Meta webhook verification challenge (same as WhatsApp). */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ companyId: string }> },
) {
  const { companyId } = await params;
  const account = await getChannelAccount(companyId, 'instagram');
  if (!account) return new Response('Not Found', { status: 404 });

  const creds = decryptCredentials(account.credentials);
  return instagramInbound.handleChallenge!(req, creds.verify_token as string);
}

/**
 * POST: Instagram webhook — verify, then parse + persist inline.
 *
 * Processed synchronously (no QStash) to match the email webhook pattern.
 * Meta requires a fast 200 ack; a few Supabase upserts comfortably fit.
 * Errors are caught and logged so we still ack 200 and avoid retry storms.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ companyId: string }> },
) {
  const { companyId } = await params;
  const account = await getChannelAccount(companyId, 'instagram');
  if (!account) return new Response('Not Found', { status: 404 });

  const creds = decryptCredentials(account.credentials);
  const isValid = await instagramInbound.verifyWebhook(req, creds.app_secret as string);
  if (!isValid) return new Response('Unauthorized', { status: 401 });

  const body = await req.json();
  insertWebhookLog('instagram', companyId, body).catch(() => {});

  try {
    const normalized = instagramInbound.parseWebhook(body, companyId);
    for (const msg of normalized) {
      const contactId = await upsertContact(
        companyId,
        'instagram',
        msg.channel_sender_id,
        msg.sender_name,
        null,
      );
      const preview = msg.text_body?.slice(0, 200) ?? null;
      const { id: conversationId, isNew } = await upsertConversation(
        companyId,
        'instagram',
        contactId,
        account.id,
        msg.channel_thread_id,
        preview,
        msg.subject ?? null,
      );
      const { isDuplicate } = await insertMessage(conversationId, msg);
      if (!isDuplicate && !isNew) await bumpConversation(conversationId, preview, 'inbound');
      if (!isDuplicate) forwardInboundToSupport({ account, msg, conversationId });
    }

    // Mark channel as connected (first webhook received)
    if (normalized.length > 0 && !account.last_webhook_at) {
      getServiceClient()
        .from('channel_accounts')
        .update({ last_webhook_at: new Date().toISOString() })
        .eq('id', account.id)
        .then(() => {});
    }
  } catch (err) {
    // Always ack Meta with 200 to avoid retry storms; log for triage.
    console.error('Instagram webhook processing failed:', err);
  }

  return new Response('OK', { status: 200 });
}
