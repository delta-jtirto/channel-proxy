import { type NextRequest } from 'next/server';
import '@/lib/adapters/line';
import {
  getChannelAccount,
  insertWebhookLog,
  upsertContact,
  upsertConversation,
  insertMessage,
  incrementConversationCounts,
} from '@/lib/db/queries';
import { getServiceClient } from '@/lib/db/supabase';
import { decryptCredentials } from '@/lib/credentials';
import { registry } from '@/lib/adapters/registry';

const LINE_API = 'https://api.line.me/v2/bot';

/** Fetch a LINE user's display name + avatar via the Profile API. */
async function fetchLineProfile(
  userId: string,
  accessToken: string,
): Promise<{ displayName: string; pictureUrl: string | null } | null> {
  try {
    const res = await fetch(`${LINE_API}/profile/${userId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      displayName?: string;
      pictureUrl?: string;
    };
    return {
      displayName: data.displayName ?? userId,
      pictureUrl: data.pictureUrl ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * POST: LINE webhook — verify signature, then parse + persist inline.
 *
 * We process synchronously in the route handler (no QStash) to match
 * the email webhook's pattern and keep the system free of external
 * queue dependencies. LINE allows a few seconds for the webhook ack;
 * a handful of Supabase upserts comfortably fit in that budget.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ companyId: string }> },
) {
  const { companyId } = await params;
  const account = await getChannelAccount(companyId, 'line');
  if (!account) return new Response('Not Found', { status: 404 });

  const creds = decryptCredentials(account.credentials);
  const adapter = registry.getInbound('line')!;

  const isValid = await adapter.verifyWebhook(req, creds.channel_secret as string);
  if (!isValid) return new Response('Unauthorized', { status: 401 });

  const body = await req.json();
  insertWebhookLog('line', companyId, body).catch(() => {});

  try {
    const normalized = adapter.parseWebhook(body, companyId);

    // Batch-fetch LINE profiles for unique senders so contacts get real
    // display names + avatars instead of raw userIds. The Profile API is
    // fast (~50ms) and we deduplicate across messages in the same webhook.
    const accessToken = creds.channel_access_token as string;
    const profileCache = new Map<
      string,
      { displayName: string; pictureUrl: string | null }
    >();
    const uniqueUserIds = [
      ...new Set(normalized.map((m) => m.channel_sender_id)),
    ];
    await Promise.all(
      uniqueUserIds.map(async (uid) => {
        const profile = await fetchLineProfile(uid, accessToken);
        if (profile) profileCache.set(uid, profile);
      }),
    );

    for (const msg of normalized) {
      const profile = profileCache.get(msg.channel_sender_id);
      const displayName = profile?.displayName ?? msg.sender_name;
      const avatarUrl = profile?.pictureUrl ?? null;

      // Also update the message's sender_name so the stored row uses the
      // real display name, not the raw LINE userId.
      (msg as { sender_name: string }).sender_name = displayName;

      const contactId = await upsertContact(
        companyId,
        'line',
        msg.channel_sender_id,
        displayName,
        avatarUrl,
      );
      const conversationId = await upsertConversation(
        companyId,
        'line',
        contactId,
        account.id,
        msg.channel_thread_id,
        msg.text_body?.slice(0, 200) ?? null,
        msg.subject ?? null,
      );
      const { isDuplicate } = await insertMessage(conversationId, msg);
      if (!isDuplicate) await incrementConversationCounts(conversationId);
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
    // Always ack LINE with 200 so it doesn't retry-storm on transient DB
    // errors. Log for triage — webhook_logs already has the raw payload.
    console.error('LINE webhook processing failed:', err);
  }

  return new Response('OK', { status: 200 });
}
