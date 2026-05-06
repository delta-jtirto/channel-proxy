import { type NextRequest } from 'next/server';
import { watiInbound } from '@/lib/adapters/wati';
import {
  getChannelAccount,
  insertWebhookLog,
  upsertContact,
  upsertConversation,
  insertMessage,
  incrementConversationCounts,
} from '@/lib/db/queries';
import { getServiceClient } from '@/lib/db/supabase';

/**
 * GET — Wati doesn't do a verification handshake like Meta. Return 200 so
 * a "test webhook" button in the Wati dashboard succeeds.
 */
export async function GET() {
  return new Response('OK', { status: 200 });
}

/**
 * POST — receive Wati webhook events. Wati posts plain JSON, no HMAC.
 * We acknowledge fast and persist inline (Wati doesn't aggressively retry,
 * but mirroring the Meta path keeps behavior consistent).
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ companyId: string }> },
) {
  const { companyId } = await params;

  const account = await getChannelAccount(companyId, 'wati');
  if (!account) {
    return new Response('Not Found', { status: 404 });
  }

  const body = await req.json().catch(() => ({}));

  // Fire-and-forget log
  insertWebhookLog('wati', companyId, body).catch(() => {});

  try {
    const normalized = watiInbound.parseWebhook(body, companyId);
    for (const msg of normalized) {
      const contactId = await upsertContact(
        companyId,
        'wati',
        msg.channel_sender_id,
        msg.sender_name,
        null,
      );
      const conversationId = await upsertConversation(
        companyId,
        'wati',
        contactId,
        account.id,
        msg.channel_thread_id,
        msg.text_body?.slice(0, 200) ?? null,
        msg.subject ?? null,
      );
      const { isDuplicate } = await insertMessage(conversationId, msg);
      if (!isDuplicate) await incrementConversationCounts(conversationId);
    }

    if (normalized.length > 0 && !account.last_webhook_at) {
      getServiceClient()
        .from('channel_accounts')
        .update({ last_webhook_at: new Date().toISOString() })
        .eq('id', account.id)
        .then(() => {});
    }
  } catch (err) {
    console.error('Wati webhook processing failed:', err);
  }

  return new Response('OK', { status: 200 });
}
