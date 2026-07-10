import { type NextRequest } from 'next/server';
import {
  getVoiceAccountByNumber,
  resolveTwilioCreds,
  insertWebhookLog,
  getCallMessageId,
  insertCallUtterances,
  mergeCallMetadata,
} from '@/lib/db/queries';
import { parseTwilioForm, verifyTwilioSignatureForAccount } from '@/lib/twilio';
import { parseTranscriptionEvent, callIdempotencyKey } from '@/lib/adapters/twilio-voice';

/**
 * POST: Twilio Real-Time Transcription callback — fires transcription-started
 * (setup) → transcription-content (one per utterance, carries text) →
 * transcription-stopped. Fields are application/x-www-form-urlencoded (NOT
 * JSON, unlike every chat webhook in this repo). Shape CONFIRMED from the Plan 2
 * spike capture 2026-07-10 (src/lib/adapters/__fixtures__/twilio-transcription-
 * event.sample.json).
 *
 * (a) NO To/From in the body — spike-confirmed the transcription payload carries
 *     only CallSid (plus Track/TranscriptionData/…), so this route CANNOT
 *     resolve the voice account by dialed number the way voice-status/recording-
 *     status do. Instead it reads the dialed number from a `?to=` QUERY PARAM on
 *     the callback URL. **Plan 4 REQUIREMENT:** when the production voice route
 *     emits `<Start><Transcription statusCallbackUrl=…>`, it MUST append
 *     `?to={To}` to that URL (…/transcription/{companyId}?to={dialedNumber}).
 *     publicUrl() includes req.nextUrl.search, so Twilio's X-Twilio-Signature —
 *     computed over the full callback URL incl. `?to=` — still validates.
 * (b) KNOWN v1 LIMITATION (ordering edge): a transcription-content event can
 *     race ahead of the voice-status webhook that creates the call's message
 *     row → getCallMessageId returns null. v1 acks 200 + warns and drops that
 *     early utterance (the bulk arrive after the row exists; seq=SequenceId keeps
 *     any late-inserts correctly ordered). Hardening (buffer/create-stub) is a
 *     Plan 4+ item, deliberately not built here.
 *
 * Node runtime (the `twilio` package needs `crypto` for signature validation —
 * must NOT opt into the edge runtime), synchronous processing like every other
 * webhook in this repo.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ companyId: string }> },
) {
  const { companyId } = await params;

  const body = await parseTwilioForm(req);

  // Account resolution: NO To/From in the transcription body (see header (a)) —
  // the dialed number is baked into the callback URL as `?to=` by Plan 4's voice
  // route. The signature is computed over the full URL incl. this query param
  // (publicUrl reconstructs pathname + search), so a forged `?to=` pointing at
  // another account fails the check below unless the attacker also holds that
  // account's token.
  const toNumber = req.nextUrl.searchParams.get('to') ?? '';
  const account = await getVoiceAccountByNumber(companyId, toNumber);
  if (!account) return new Response('Not Found', { status: 404 });

  // Delta-owned env creds by default; the row's own creds if a host BYO'd.
  const { authToken } = resolveTwilioCreds(account);
  if (!verifyTwilioSignatureForAccount(authToken, req, body)) {
    return new Response('Unauthorized', { status: 401 });
  }

  insertWebhookLog('voice-transcription', companyId, body).catch(() => {});

  // Only transcription-content events carry text; started/stopped → null → ack.
  const parsed = parseTranscriptionEvent(body);
  if (!parsed) return new Response('OK', { status: 200 });

  try {
    const idempotencyKey = callIdempotencyKey(parsed.callSid);
    const messageId = await getCallMessageId(idempotencyKey);

    if (!messageId) {
      // Ordering edge (see header (b)): transcription raced ahead of the
      // voice-status row that creates the call message. Ack 200 + warn; drop
      // this early utterance rather than crashing/retrying.
      console.warn(
        `Transcription content for call ${parsed.callSid} arrived before its message row exists (voice-status webhook raced) — dropping utterance seq ${parsed.seq}. Known v1 ordering limitation.`,
      );
      return new Response('OK', { status: 200 });
    }

    await insertCallUtterances([
      {
        messageId,
        companyId,
        seq: parsed.seq, // = SequenceId, already per-call unique/ordered
        speaker: parsed.speaker,
        text: parsed.text,
        isFinal: parsed.isFinal,
        offsetMs: null, // spike confirmed no per-utterance audio offset is sent
        channelTimestamp: parsed.timestamp,
      },
    ]);

    // transcript_ref = the call's own messages.id (the join key into
    // call_utterances.message_id). Idempotent, so setting it on every utterance
    // is harmless — simplest is to set it unconditionally.
    await mergeCallMetadata(idempotencyKey, { transcript_ref: messageId });
  } catch (err) {
    console.error('Twilio transcription webhook processing failed:', err);
  }

  return new Response('OK', { status: 200 });
}
