import { NextResponse } from 'next/server';
import { verifyQStashSignature, type WebhookPayload } from '@/lib/queue';
import { getChannelAccountId, upsertContact, upsertConversation, insertMessage, bumpConversation } from '@/lib/db/queries';
import type { Channel, NormalizedMessage } from '@/lib/adapters/types';

// Import all adapters to register them.
// Email goes through the SMTP adapter, which also wires up emailInbound.
import '@/lib/adapters/whatsapp';
import '@/lib/adapters/instagram';
import '@/lib/adapters/line';
import '@/lib/adapters/email/smtp';
import { registry } from '@/lib/adapters/registry';

/**
 * POST: Background webhook processor.
 * Called by QStash after a webhook is enqueued.
 * Handles the actual parsing, normalization, and database writes.
 */
export async function POST(req: Request) {
  let payload: WebhookPayload;

  try {
    // In production, verify QStash signature
    if (process.env.QSTASH_CURRENT_SIGNING_KEY) {
      payload = await verifyQStashSignature(req);
    } else {
      // Local development: skip verification
      payload = (await req.json()) as WebhookPayload;
    }
  } catch (err) {
    console.error('QStash verification failed:', err);
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { channel, companyId, payload: webhookBody } = payload;

  try {
    // Get the adapter for this channel
    const adapter = registry.getInbound(channel as Channel);
    if (!adapter) {
      console.error(`No inbound adapter for channel: ${channel}`);
      return NextResponse.json({ error: `Unknown channel: ${channel}` }, { status: 400 });
    }

    // Get the channel account
    const account = await getChannelAccountId(companyId, channel);
    if (!account) {
      console.error(`No active account for company=${companyId} channel=${channel}`);
      return NextResponse.json({ error: 'Account not found' }, { status: 404 });
    }

    // Parse webhook into normalized messages
    const normalizedMessages = adapter.parseWebhook(webhookBody, companyId);

    if (normalizedMessages.length === 0) {
      // No messages to process (could be a status update, etc.)
      return NextResponse.json({ processed: 0 });
    }

    let processed = 0;
    let duplicates = 0;

    for (const msg of normalizedMessages) {
      try {
        await processMessage(msg, account.id);
        processed++;
      } catch (err) {
        if (err instanceof Error && err.message.includes('duplicate')) {
          duplicates++;
        } else {
          console.error('Failed to process message:', err);
          throw err;
        }
      }
    }

    return NextResponse.json({ processed, duplicates });
  } catch (err) {
    console.error(`Webhook processing failed for ${channel}/${companyId}:`, err);
    return NextResponse.json(
      { error: 'Processing failed' },
      { status: 500 },
    );
  }
}

/**
 * Process a single normalized message:
 * 1. Upsert contact
 * 2. Upsert conversation
 * 3. Insert message (with idempotency)
 */
async function processMessage(msg: NormalizedMessage, accountId: string) {
  // 1. Upsert contact
  const contactId = await upsertContact(
    msg.company_id,
    msg.channel,
    msg.channel_sender_id,
    msg.sender_name,
    null, // avatar_url — can be fetched later
  );

  // 2. Upsert conversation
  const preview = msg.text_body?.slice(0, 200) ?? null;
  const { id: conversationId, isNew } = await upsertConversation(
    msg.company_id,
    msg.channel,
    contactId,
    accountId,
    msg.channel_thread_id,
    preview,
    msg.subject ?? null,
  );

  // 3. Insert message (idempotent)
  const { isDuplicate } = await insertMessage(conversationId, msg);

  if (isDuplicate) {
    throw new Error('duplicate');
  }

  // 4. Bump conversation (last_message + counts). New conversations are
  // already seeded by the INSERT, so only bump existing ones.
  if (!isNew) await bumpConversation(conversationId, preview, 'inbound');
}
