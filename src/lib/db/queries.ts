import { getServiceClient } from './supabase';
import { decryptCredentials } from '@/lib/credentials';
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
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error || !data) return null;
  return data;
}

/**
 * Lightweight account lookup that selects ONLY id + company_id — skips the
 * encrypted credentials blob. Use on hot paths that only need account.id
 * (e.g. the process-webhook worker). Callers that need credentials for
 * signature verification must keep using getChannelAccount.
 */
export async function getChannelAccountId(companyId: string, channel: string) {
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from('channel_accounts')
    .select('id, company_id')
    .eq('company_id', companyId)
    .eq('channel', channel)
    .eq('is_active', true)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

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
    .select('id, display_name, avatar_url')
    .eq('company_id', companyId)
    .eq('channel', channel)
    .eq('channel_contact_id', channelContactId)
    .single();

  if (existing) {
    // Only write when identity (name/avatar) actually changed. last_seen_at
    // now refreshes only when identity changes (accepted tradeoff to drop
    // per-message write churn).
    const needsUpdate =
      (displayName && displayName !== existing.display_name) ||
      (avatarUrl && avatarUrl !== existing.avatar_url);
    if (needsUpdate) {
      await supabase
        .from('contacts')
        .update({
          last_seen_at: new Date().toISOString(),
          ...(displayName && displayName !== existing.display_name
            ? { display_name: displayName }
            : {}),
          ...(avatarUrl && avatarUrl !== existing.avatar_url
            ? { avatar_url: avatarUrl }
            : {}),
        })
        .eq('id', existing.id);
    }
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
): Promise<{ id: string; isNew: boolean }> {
  const supabase = getServiceClient();

  // Try to find existing conversation by channel thread
  const { data: existing } = await supabase
    .from('conversations')
    .select('id')
    .eq('company_id', companyId)
    .eq('channel', channel)
    .eq('contact_id', contactId)
    .eq('account_id', accountId)
    .maybeSingle();

  const now = new Date().toISOString();

  if (existing) {
    // No write here: the last_message_* fields and counts are bumped in a
    // single round-trip by bumpConversation() once the message is confirmed
    // non-duplicate. This collapses the previous double-write per message.
    return { id: existing.id, isNew: false };
  }

  // Create new conversation. The INSERT already sets counts=1 and the
  // last_message_* fields, so a brand-new conversation needs NO bump
  // (that was the prior off-by-one).
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
  return { id: newConvo!.id, isNew: true };
}

/**
 * Bump an EXISTING conversation in a single round-trip: refresh last_message_*,
 * mark active, and increment message_count (+ unread_count for inbound). Only
 * call for confirmed non-duplicate messages on conversations that already
 * existed before this message (a brand-new conversation is seeded by the
 * upsertConversation INSERT and must NOT be bumped, else counts double).
 */
export async function bumpConversation(
  conversationId: string,
  preview: string | null,
  direction: 'inbound' | 'outbound',
): Promise<void> {
  const supabase = getServiceClient();
  await supabase.rpc('bump_conversation_on_message', {
    p_conversation_id: conversationId,
    p_preview: preview,
    p_direction: direction,
  });
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

// ============================================================
// Voice account resolution (route by dialed number, email-style)
// ============================================================

/**
 * A channel_accounts row, as read by the voice ingest path. NOTE: this
 * repo has no shared ChannelAccountRow type today — the email webhook route
 * (webhooks/email/[companyId]/route.ts:8-18) keeps its own file-local copy.
 * This is the exported version voice uses; the two are a flagged, accepted
 * duplication (the email copy types `credentials` non-null, which its
 * decrypt call requires; voice needs it nullable — see below).
 *
 * `credentials` is typed `string | null` deliberately even though the DB
 * column is `TEXT NOT NULL` (initial_schema.sql:49): the Delta-owned voice
 * ownership mode carries no Twilio creds of its own, so resolveTwilioCreds
 * must tolerate the ABSENCE of account_sid/auth_token and fall back to env.
 * (A Delta-owned row still stores *some* non-null encrypted blob to satisfy
 * the NOT NULL — e.g. an encrypted `{}` or handle-only object — so the env
 * fallback triggers on missing KEYS, not a null column. Plan 4's connect
 * flow owns writing that blob.)
 */
export interface ChannelAccountRow {
  id: string;
  company_id: string;
  channel: string;
  display_name: string | null;
  handle: string | null;
  delivery_target: string | null;
  credentials: string | null;
  is_active: boolean;
  last_webhook_at: string | null;
  host_id: string | null;
}

/**
 * Resolve the ONE voice account for a company whose Twilio number was dialed.
 * Mirrors the email webhook's mailbox disambiguation
 * (webhooks/email/[companyId]/route.ts:64-76): fetch all active voice accounts
 * for the company and match `handle === toNumber` in JS (PostgREST filtering on
 * '+'-prefixed E.164 is fine, but JS keeps parity with the email pattern and
 * tolerates any handle normalization). Returns null when no number matches
 * (caller 404s / 200-acks). This REPLACES getChannelAccount(companyId,'voice')
 * — voice is multi-number-per-company (see Architecture), so a single-row
 * lookup would mis-route.
 */
export async function getVoiceAccountByNumber(
  companyId: string,
  toNumber: string,
): Promise<ChannelAccountRow | null> {
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from('channel_accounts')
    .select(
      'id, company_id, channel, display_name, handle, delivery_target, credentials, is_active, last_webhook_at, host_id',
    )
    .eq('company_id', companyId)
    .in('channel', ['voice', 'video'])
    .eq('is_active', true);
  if (error) {
    console.error('Voice account lookup failed:', error.message);
    return null;
  }
  return (
    ((data ?? []) as ChannelAccountRow[]).find((a) => a.handle === toNumber) ?? null
  );
}

/**
 * Resolve the Twilio credentials for a voice account: the row's own encrypted
 * creds when a host brought their own Twilio (BYO), else Delta's env-level
 * account (the default — the row carries no usable creds). Both modes flow
 * through the same route code; only the returned token differs. The env
 * fallback triggers on the ABSENCE of account_sid/auth_token keys in the
 * decrypted blob, not on a null column (the column is NOT NULL — see
 * ChannelAccountRow).
 */
export function resolveTwilioCreds(
  account: ChannelAccountRow,
): { accountSid: string; authToken: string } {
  const rowCreds: Record<string, unknown> =
    account.credentials != null ? decryptCredentials(account.credentials) : {};
  const accountSid =
    typeof rowCreds.account_sid === 'string'
      ? rowCreds.account_sid
      : (process.env.TWILIO_ACCOUNT_SID ?? '');
  const authToken =
    typeof rowCreds.auth_token === 'string'
      ? rowCreds.auth_token
      : (process.env.TWILIO_AUTH_TOKEN ?? '');
  return { accountSid, authToken };
}

// ============================================================
// Call message upsert (voice channel — lifecycle events)
// ============================================================

export interface CallMessageUpsertArgs {
  conversationId: string;
  companyId: string;
  channel: 'voice' | 'video';
  direction: 'inbound' | 'outbound';
  senderId: string;
  channelMessageId: string; // Twilio CallSid
  idempotencyKey: string; // callIdempotencyKey(CallSid)
  textBody: string;
  metadataPatch: Record<string, unknown>;
  channelTimestamp: string; // ISO
}

/**
 * Create-or-merge-update the ONE messages row for a call's whole lifecycle.
 * Returns isNew so the caller knows whether to bump conversation counts
 * (first-ever event for this CallSid) or just refresh the preview (a later
 * lifecycle event on an already-counted call) — see upsert_call_message's
 * migration comment for why this distinction matters.
 */
export async function upsertCallMessage(
  args: CallMessageUpsertArgs,
): Promise<{ id: string; isNew: boolean }> {
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .rpc('upsert_call_message', {
      p_conversation_id: args.conversationId,
      p_company_id: args.companyId,
      p_channel: args.channel,
      p_direction: args.direction,
      p_sender_id: args.senderId,
      p_channel_message_id: args.channelMessageId,
      p_idempotency_key: args.idempotencyKey,
      p_text_body: args.textBody,
      p_metadata_patch: args.metadataPatch,
      p_channel_timestamp: args.channelTimestamp,
    })
    .single();

  if (error) throw new Error(`Failed to upsert call message: ${error.message}`);
  const row = data as { id: string; is_new: boolean };
  return { id: row.id, isNew: row.is_new };
}

/**
 * Merge fields onto an ALREADY-EXISTING call message's metadata, without
 * touching text_body/channel_timestamp. Used by events that arrive after the
 * call's lifecycle text is already set (recording-status, and later
 * transcript_ref) — see upsert_call_metadata_only's migration comment.
 */
export async function mergeCallMetadata(
  idempotencyKey: string,
  metadataPatch: Record<string, unknown>,
): Promise<void> {
  const supabase = getServiceClient();
  const { error } = await supabase.rpc('upsert_call_metadata_only', {
    p_idempotency_key: idempotencyKey,
    p_metadata_patch: metadataPatch,
  });
  if (error) throw new Error(`Failed to merge call metadata: ${error.message}`);
}

/**
 * Refresh a conversation's preview/timestamp WITHOUT touching message_count
 * or unread_count — for a call-lifecycle event that updates an EXISTING
 * call-message row (bumpConversation would double-count otherwise, since
 * bump_conversation_on_message always increments message_count).
 */
export async function refreshConversationPreview(
  conversationId: string,
  preview: string,
): Promise<void> {
  const supabase = getServiceClient();
  const now = new Date().toISOString();
  await supabase
    .from('conversations')
    .update({ last_message_preview: preview, last_message_at: now, updated_at: now })
    .eq('id', conversationId);
}

/**
 * Look up the call's messages.id by its idempotency_key
 * (callIdempotencyKey(CallSid)). Mirrors updateMessageStatusByChannelId's
 * SELECT-by-column shape, but uses .maybeSingle() over .single() because the
 * row's ABSENCE is an expected, non-error outcome here: a transcription-content
 * event can race ahead of the voice-status webhook that creates the call's
 * message row (the transcription route acks 200 + warns in that case). Using
 * .single() would spuriously raise PGRST116 on every such race — same rationale
 * insertMessage documents for its own .maybeSingle() choice.
 */
export async function getCallMessageId(
  idempotencyKey: string,
): Promise<string | null> {
  const supabase = getServiceClient();
  const { data } = await supabase
    .from('messages')
    .select('id')
    .eq('idempotency_key', idempotencyKey)
    .maybeSingle();
  return data?.id ?? null;
}

// ============================================================
// Call transcript utterances
// ============================================================

export interface CallUtteranceRow {
  messageId: string;
  companyId: string;
  seq: number;
  speaker: 'agent' | 'guest' | 'system';
  text: string;
  isFinal: boolean;
  offsetMs: number | null;
  channelTimestamp: string;
}

export async function insertCallUtterances(rows: CallUtteranceRow[]): Promise<void> {
  if (rows.length === 0) return;
  const supabase = getServiceClient();
  const { error } = await supabase.from('call_utterances').insert(
    rows.map((r) => ({
      message_id: r.messageId,
      company_id: r.companyId,
      seq: r.seq,
      speaker: r.speaker,
      text: r.text,
      is_final: r.isFinal,
      offset_ms: r.offsetMs,
      channel_timestamp: r.channelTimestamp,
    })),
  );
  if (error) throw new Error(`Failed to insert call utterances: ${error.message}`);
}
