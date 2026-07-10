// Pure Twilio-payload mapping + formatting helpers for the voice channel.
//
// Cross-repo note: this intentionally MIRRORS the string output of
// src/core/voice/format.ts (formatCallDuration / formatCallPreview) in the
// AI CS BPO repo. The two repos have no shared package, so this is a
// deliberate, documented duplication (same category as NormalizedMessage vs
// ProxyMessage already in this codebase) — not a parallel source of truth to
// silently drift. If Plan 4 changes BPO's formatCallPreview, update this file
// to match, or (better) have Plan 4 re-derive the preview from `metadata` at
// render time so BPO's copy always wins.

/** Our CallRecord.status domain (src/core/voice/types.ts in the AI CS BPO repo). */
export type CallStatus = 'completed' | 'missed' | 'voicemail' | 'failed' | 'in-progress';

/**
 * Map Twilio's CallStatus [CONFIRMED — stable enum: queued, ringing,
 * in-progress, completed, busy, failed, no-answer, canceled] onto our
 * CallStatus domain.
 *
 * 'voicemail' is never produced here — Twilio has no native CallStatus for
 * it. Voicemail is a distinct TwiML flow (record-after-no-answer, or
 * Answering Machine Detection's `AnsweredBy` field) that Plan 4 would need to
 * build and signal explicitly (e.g. a query param on its own callback URL);
 * Plan 3 does not build that flow, so this mapper honestly never returns it.
 */
export function mapTwilioCallStatus(
  twilioStatus: string,
  callDurationSec: number | null,
): CallStatus {
  switch (twilioStatus) {
    case 'queued':
    case 'ringing':
    case 'in-progress':
      return 'in-progress';
    case 'completed':
      return callDurationSec && callDurationSec > 0 ? 'completed' : 'missed';
    case 'no-answer':
      return 'missed';
    case 'busy':
    case 'failed':
    case 'canceled':
      return 'failed';
    default:
      return 'in-progress';
  }
}

/** Mirrors formatCallDuration in src/core/voice/format.ts (AI CS BPO repo). */
export function formatCallDurationMirror(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) {
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return rem === 0 ? `${m}m` : `${m}m ${rem}s`;
  }
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/** Mirrors formatCallPreview in src/core/voice/format.ts (AI CS BPO repo).
 *  Plan 3 only produces 'inbound'-direction calls, but the direction
 *  parameter is kept so this mirror stays byte-identical to the real
 *  formatter if Plan 4/9 ever reuses it for outbound/video. */
export function formatCallPreviewMirror(
  status: CallStatus,
  durationSec: number | null,
  direction: 'inbound' | 'outbound' = 'inbound',
): string {
  if (status === 'in-progress') return 'Call in progress…';
  if (status === 'missed') return 'Missed call';
  if (status === 'failed') return 'Failed call';

  const dur = durationSec != null ? ` · ${formatCallDurationMirror(durationSec)}` : '';
  if (status === 'voicemail') return `Voicemail${dur}`;

  const label = direction === 'inbound' ? 'Inbound call' : 'Outbound call';
  return `${label}${dur}`;
}

/**
 * Resolve the contact-lookup id for a caller. Twilio sends the literal
 * strings 'anonymous' or 'restricted' in `From` [CONFIRMED — documented
 * Twilio behavior for blocked/unavailable caller ID], and occasionally an
 * empty value. Without this fallback, `upsertContact` would key ALL blocked
 * callers for a company onto ONE contact row (same company_id + channel +
 * channel_contact_id='anonymous'), silently merging distinct people's call
 * history into a single thread. Falling back to a CallSid-scoped synthetic
 * id keeps every blocked call its own contact/conversation.
 */
export function resolveCallerContactId(from: string, callSid: string): string {
  const blocked = !from || from === 'anonymous' || from === 'restricted';
  return blocked ? `blocked:${callSid}` : from;
}

/** Supabase Storage object path for a call recording: {company_id}/{CallSid}.mp3 */
export function recordingStoragePath(companyId: string, callSid: string): string {
  return `${companyId}/${callSid}.mp3`;
}

/** messages.idempotency_key for a call's message row. Prefixed so it can
 *  never collide with a chat channel's `{channel}_{channel_msg_id}` key
 *  shape (NormalizedMessage.idempotency_key, adapters/types.ts:60). */
export function callIdempotencyKey(callSid: string): string {
  return `voice_${callSid}`;
}
