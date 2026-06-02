import { getServiceClient } from './supabase';
import type { NormalizedMessage } from '@/lib/adapters/types';

// ============================================================
// Webhook Log
// ============================================================

export async function insertWebhookLog(
  channel: string,
  companyId: string | null,
  rawPayload: unknown,
) {
  const supabase = getServiceClient();
  const { error } = await supabase.from('webhook_logs').insert({
    channel,
    company_id: companyId,
    raw_payload: rawPayload,
    status: 'received',
  });
  if (error) console.error('Failed to insert webhook log:', error.message);
}

// ============================================================
// Channel Account lookup
// ============================================================

export async function getChannelAccount(companyId: string, channel: string) {
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from('channel_accounts')
    .select('*')
    .eq('company_id', companyId)
    .eq('channel', channel)
    .eq('is_active', true)
    .single();

  if (error || !data) return null;
  return data;
}

// ============================================================
// Contact upsert
// ============================================================

export async function upsertContact(
  companyId: string,
  channel: string,
  channelContactId: string,
  displayName: string | null,
  avatarUrl: string | null,
): Promise<string> {
  const supabase = getServiceClient();

  // Try to find existing contact
  const { data: existing } = await supabase
    .from('contacts')
    .select('id')
    .eq('company_id', companyId)
    .eq('channel', channel)
    .eq('channel_contact_id', channelContactId)
    .single();

  if (existing) {
    // Update last_seen and name if available
    await supabase
      .from('contacts')
      .update({
        last_seen_at: new Date().toISOString(),
        ...(displayName ? { display_name: displayName } : {}),
        ...(avatarUrl ? { avatar_url: avatarUrl } : {}),
      })
      .eq('id', existing.id);
    return existing.id;
  }

  // Create new contact
  const { data: newContact, error } = await supabase
    .from('contacts')
    .insert({
      company_id: companyId,
      channel,
      channel_contact_id: channelContactId,
      display_name: displayName,
      avatar_url: avatarUrl,
    })
    .select('id')
    .single();

  if (error) throw new Error(`Failed to create contact: ${error.message}`);
  return newContact!.id;
}

// ============================================================
// Conversation upsert
// ============================================================

export async function upsertConversation(
  companyId: string,
  channel: string,
  contactId: string,
  accountId: string,
  channelThreadId: string,
  lastMessagePreview: string | null,
  subject: string | null,
  /**
   * Direction of the message that triggered this upsert. Every current
   * caller is a webhook / mailbox poller (inbound), so this defaults to
   * 'inbound' for back-compat. The send route updates the conversation
   * separately and sets 'outbound' itself.
   */
  direction: 'inbound' | 'outbound' = 'inbound',
): Promise<string> {
  const supabase = getServiceClient();

  // Try to find existing conversation by channel thread
  const { data: existing } = await supabase
    .from('conversations')
    .select('id, message_count, unread_count')
    .eq('company_id', companyId)
    .eq('channel', channel)
    .eq('contact_id', contactId)
    .eq('account_id', accountId)
    .maybeSingle();

  const now = new Date().toISOString();

  if (existing) {
    await supabase
      .from('conversations')
      .update({
        last_message_at: now,
        last_message_preview: lastMessagePreview,
        last_message_direction: direction,
        updated_at: now,
        status: 'active',
      })
      .eq('id', existing.id);
    return existing.id;
  }

  // Create new conversation
  const { data: newConvo, error } = await supabase
    .from('conversations')
    .insert({
      company_id: companyId,
      channel,
      contact_id: contactId,
      account_id: accountId,
      channel_thread_id: channelThreadId,
      subject,
      last_message_at: now,
      last_message_preview: lastMessagePreview,
      last_message_direction: direction,
      unread_count: 1,
      message_count: 1,
    })
    .select('id')
    .single();

  if (error) throw new Error(`Failed to create conversation: ${error.message}`);
  return newConvo!.id;
}

// ============================================================
// Message insert (with idempotency)
// ============================================================

export async function insertMessage(
  conversationId: string,
  msg: NormalizedMessage,
): Promise<{ id: string; isDuplicate: boolean }> {
  const supabase = getServiceClient();

  // NOTE: with `ignoreDuplicates: true`, a conflict on idempotency_key causes
  // the row to be skipped silently and `.select('id')` returns 0 rows. Using
  // `.single()` on that result errors with PGRST116, which the caller would
  // then misinterpret as a real failure. `.maybeSingle()` returns null data
  // instead, which we can treat as "duplicate — already stored".
  const { data, error } = await supabase
    .from('messages')
    .upsert(
      {
        conversation_id: conversationId,
        company_id: msg.company_id,
        channel: msg.channel,
        direction: msg.direction,
        sender_id: msg.channel_sender_id,
        sender_name: msg.sender_name,
        content_type: msg.content_type,
        text_body: msg.text_body,
        html_body: msg.html_body ?? null,
        subject: msg.subject ?? null,
        attachments: msg.attachments,
        metadata: msg.metadata,
        channel_message_id: msg.channel_message_id,
        status: 'received',
        idempotency_key: msg.idempotency_key,
        channel_timestamp: msg.channel_timestamp,
        received_at: new Date().toISOString(),
      },
      { onConflict: 'idempotency_key', ignoreDuplicates: true },
    )
    .select('id')
    .maybeSingle();

  if (error) {
    // A 23505 "duplicate key" error shouldn't happen with ignoreDuplicates=true,
    // but keep the fallback check for safety.
    if (error.code === '23505' || error.message?.includes('duplicate')) {
      return { id: '', isDuplicate: true };
    }
    throw new Error(`Failed to insert message: ${error.message}`);
  }

  if (!data) {
    // Row already existed — ignoreDuplicates swallowed it.
    return { id: '', isDuplicate: true };
  }

  return { id: data.id, isDuplicate: false };
}

// ============================================================
// Conversation count increment (call after confirmed new message)
// ============================================================

/**
 * Apply a delivery-status update to a previously-sent outbound message.
 * Matches by `channel_message_id` (the provider's message id, e.g. wamid.xxx).
 *
 * Idempotent and monotonic: never downgrades 'read' → 'delivered'. Skips the
 * write when the new status equals the current to keep WAL traffic minimal.
 */
const STATUS_RANK: Record<string, number> = {
  received: 0,
  sent: 1,
  delivered: 2,
  read: 3,
  failed: 4, // failed wins over any positive state since it's terminal
};

export async function updateMessageStatusByChannelId(
  channelMessageId: string,
  status: string,
  errorMessage?: string,
): Promise<void> {
  if (!channelMessageId) return;
  const supabase = getServiceClient();
  const { data: existing } = await supabase
    .from('messages')
    .select('id, status')
    .eq('channel_message_id', channelMessageId)
    .single();
  if (!existing) return;
  const currentRank = STATUS_RANK[existing.status] ?? 0;
  const incomingRank = STATUS_RANK[status] ?? 0;
  if (incomingRank <= currentRank && status !== 'failed') return;
  await supabase
    .from('messages')
    .update({
      status,
      ...(errorMessage ? { error_message: errorMessage } : {}),
    })
    .eq('id', existing.id);
}

export async function incrementConversationCounts(conversationId: string) {
  const supabase = getServiceClient();
  const { data: conv } = await supabase
    .from('conversations')
    .select('unread_count, message_count')
    .eq('id', conversationId)
    .single();
  if (conv) {
    await supabase
      .from('conversations')
      .update({
        unread_count: (conv.unread_count ?? 0) + 1,
        message_count: (conv.message_count ?? 0) + 1,
      })
      .eq('id', conversationId);
  }
}
