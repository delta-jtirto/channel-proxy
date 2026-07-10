import { type NextRequest } from 'next/server';
import {
  getVoiceAccountByNumber,
  resolveTwilioCreds,
  insertWebhookLog,
  mergeCallMetadata,
} from '@/lib/db/queries';
import { getServiceClient } from '@/lib/db/supabase';
import { parseTwilioForm, verifyTwilioSignatureForAccount } from '@/lib/twilio';
import { recordingStoragePath, callIdempotencyKey } from '@/lib/adapters/twilio-voice';

/**
 * POST: Twilio recording-status callback. Fires once RecordingStatus=
 * 'completed'. Downloads the media (Twilio Basic Auth), uploads it to this
 * project's own Supabase Storage (never leave the only copy on Twilio), then
 * merges `metadata.recording_url` (the STORAGE PATH, not Twilio's URL) onto
 * the call's existing messages row via `mergeCallMetadata` (Task 4) —
 * NOT `upsertCallMessage`: this event never creates a new call turn and must
 * not touch text_body/channel_timestamp, only add a metadata field.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ companyId: string }> },
) {
  const { companyId } = await params;

  const body = await parseTwilioForm(req);
  // Recording-status callbacks carry the original call's To/From/CallSid
  // [SPIKE-VERIFY the exact param set from Plan 2]. If the spike shows `To` is
  // absent on recording callbacks, bake the number into the callback URL query
  // at config time (Plan 4 sets these per-number) — the `?to=` fallback reads it.
  const toNumber = body.To ?? req.nextUrl.searchParams.get('to') ?? '';
  const account = await getVoiceAccountByNumber(companyId, toNumber);
  if (!account) return new Response('Not Found', { status: 404 });

  const { accountSid, authToken } = resolveTwilioCreds(account);
  if (!verifyTwilioSignatureForAccount(authToken, req, body)) {
    return new Response('Unauthorized', { status: 401 });
  }

  insertWebhookLog('voice', companyId, body).catch(() => {});

  if (body.RecordingStatus !== 'completed') {
    return new Response('OK', { status: 200 });
  }

  try {
    const callSid = body.CallSid;
    const mediaUrl = `${body.RecordingUrl}.mp3`;
    const basicAuth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');

    const mediaRes = await fetch(mediaUrl, {
      headers: { Authorization: `Basic ${basicAuth}` },
    });
    if (!mediaRes.ok) {
      throw new Error(`Recording fetch failed: ${mediaRes.status}`);
    }
    const buffer = Buffer.from(await mediaRes.arrayBuffer());

    const path = recordingStoragePath(companyId, callSid);
    const { error: uploadErr } = await getServiceClient()
      .storage.from('call-recordings')
      .upload(path, buffer, { contentType: 'audio/mpeg', upsert: true });
    if (uploadErr) throw new Error(`Storage upload failed: ${uploadErr.message}`);

    const recordingDuration = body.RecordingDuration
      ? Number.parseInt(body.RecordingDuration, 10)
      : null;

    // Merge onto the existing call message row — text_body/last_message_
    // preview are left exactly as Task 5's lifecycle events last set them
    // (recording arriving doesn't change the human-facing "Inbound call ·
    // 4m 12s" summary). mergeCallMetadata's UPDATE is keyed by
    // idempotency_key, so it targets the SAME messages row Task 5 created —
    // no new row, no conversation bump (this event doesn't add a call turn).
    await mergeCallMetadata(callIdempotencyKey(callSid), {
      recording_url: path,
      recording_duration_sec: recordingDuration,
    });
  } catch (err) {
    console.error('Twilio recording-status webhook processing failed:', err);
  }

  return new Response('OK', { status: 200 });
}
