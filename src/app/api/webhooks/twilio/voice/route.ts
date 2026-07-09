import { type NextRequest } from 'next/server';
import twilio from 'twilio';
import {
  SPIKE_AGENT_IDENTITY,
  parseTwilioForm,
  publicOrigin,
  verifyTwilioSignature,
} from '@/lib/twilio';

/**
 * POST /api/webhooks/twilio/voice
 *
 * Twilio calls this when the number receives an inbound call. We verify
 * the X-Twilio-Signature (reject 403 on mismatch), then return TwiML that:
 *   1. `<Start><Transcription>` — begins Real-Time Transcription and
 *      streams events to the transcription status-callback webhook.
 *   2. `<Dial><Client>` — rings the agent's browser softphone.
 *
 * If the client doesn't answer within the timeout, Twilio falls through
 * to the `<Say>` + `<Hangup>` no-answer message.
 */
export async function POST(req: NextRequest) {
  const params = await parseTwilioForm(req);

  if (!verifyTwilioSignature(req, params)) {
    return new Response('Forbidden', { status: 403 });
  }

  // Spike visibility: surface the incoming call in `next dev` / Vercel logs.
  console.info('[twilio-voice] inbound call', {
    callSid: params.CallSid,
    from: params.From,
    to: params.To,
    callStatus: params.CallStatus,
  });

  const origin = publicOrigin(req);
  const twiml = new twilio.twiml.VoiceResponse();

  // 1. Real-Time Transcription. `both_tracks` captures guest + agent so
  //    Plan 3 can attribute turns; events POST to the transcription webhook.
  const start = twiml.start();
  start.transcription({
    statusCallbackUrl: `${origin}/api/webhooks/twilio/transcription`,
    track: 'both_tracks',
  });

  // 2. Ring the browser softphone. answerOnBridge keeps the caller hearing
  //    ringing (not silence) until the agent picks up.
  const dial = twiml.dial({ answerOnBridge: true, timeout: 15 });
  dial.client(SPIKE_AGENT_IDENTITY);

  // No-answer fallback: Twilio continues here if the Dial doesn't connect.
  twiml.say(
    'Sorry, no agent is available right now. Please try again later.',
  );
  twiml.hangup();

  return new Response(twiml.toString(), {
    headers: { 'Content-Type': 'text/xml' },
  });
}
