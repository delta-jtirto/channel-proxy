import { type NextRequest } from 'next/server';
import { whatsappInbound } from '@/lib/adapters/whatsapp';
import {
  getChannelAccount,
  insertWebhookLog,
  upsertContact,
  upsertConversation,
  insertMessage,
} from '@/lib/db/queries';
import { getServiceClient } from '@/lib/db/supabase';
import { decryptCredentials } from '@/lib/credentials';

/**
 * GET: Meta webhook verification challenge.
 * Meta sends this during webhook registration to verify ownership.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ companyId: string }> },
) {
  const { companyId } = await params;

  // Look up the account to get the verify token
  const account = await getChannelAccount(companyId, 'whatsapp');
  if (!account) {
    return new Response('Not Found', { status: 404 });
  }

  const creds = decryptCredentials(account.credentials);
  const verifyToken = creds.verify_token as string;

  return whatsappInbound.handleChallenge!(req, verifyToken);
}

/**
 * POST: Receive WhatsApp webhook — verify, then parse + persist inline.
 *
 * Processed synchronously in the route handler (no QStash), matching the
 * email webhook pattern. Meta requires a fast 200 ack, and a handful of
 * Supabase upserts comfortably fit within that budget. Errors are caught
 * and logged so we still ack 200 and avoid retry storms.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ companyId: string }> },
) {
  const { companyId } = await params;

  // Look up account for signature verification
  const account = await getChannelAccount(companyId, 'whatsapp');
  if (!account) {
    return new Response('Not Found', { status: 404 });
  }

  const creds = decryptCredentials(account.credentials);
  const appSecret = creds.app_secret as string;

  // Verify webhook signature
  const isValid = await whatsappInbound.verifyWebhook(req, appSecret);
  if (!isValid) {
    return new Response('Unauthorized', { status: 401 });
  }

  // Parse body
  const body = await req.json();

  // Log webhook (async, don't block response)
  insertWebhookLog('whatsapp', companyId, body).catch(() => {});

  try {
    const normalized = whatsappInbound.parseWebhook(body, companyId);
    for (const msg of normalized) {
      const contactId = await upsertContact(
        companyId,
        'whatsapp',
        msg.channel_sender_id,
        msg.sender_name,
        null,
      );
      const conversationId = await upsertConversation(
        companyId,
        'whatsapp',
        contactId,
        account.id,
        msg.channel_thread_id,
        msg.text_body?.slice(0, 200) ?? null,
        msg.subject ?? null,
      );
      await insertMessage(conversationId, msg);
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
    console.error('WhatsApp webhook processing failed:', err);
  }

  // Return 200 immediately — Meta requires fast response
  return new Response('OK', { status: 200 });
}
