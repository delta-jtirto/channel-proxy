import twilio from 'twilio';

/**
 * The Twilio Client identity every online operator's browser registers under,
 * and the identity the inbound TwiML dials. One identity per company → Twilio
 * forks the call to all registered browsers (ring-all, first-accept-wins).
 * Single source of truth: the token route (A2) mints tokens for this exact
 * identity so a browser can only register as its own company.
 */
export function resolveVoiceIdentity(companyId: string): string {
  return `voice:${companyId}`;
}

/**
 * TwiML for an inbound call: (1) start Twilio-native Real-Time Transcription,
 * baking `?to={dialedNumber}` into the callback so the transcription route —
 * whose payload lacks To/From — can resolve the account; (2) dial the company
 * browser client. The Dial `action` (not linear fallthrough) drives voicemail
 * ONLY when the dial fails, fixing the spike bug where a caller heard "no
 * agent" after the agent hung up first.
 */
export function buildAnswerTwiml(opts: {
  companyId: string;
  toNumber: string;
  origin: string;
}): string {
  const { companyId, toNumber, origin } = opts;
  const res = new twilio.twiml.VoiceResponse();

  const start = res.start();
  start.transcription({
    statusCallbackUrl: `${origin}/api/webhooks/twilio/transcription/${companyId}?to=${encodeURIComponent(
      toNumber,
    )}`,
    track: 'both_tracks',
  });

  const dial = res.dial({
    answerOnBridge: true,
    timeout: 20,
    action: `${origin}/api/webhooks/twilio/voice/${companyId}?stage=dial-result`,
  });
  dial.client(resolveVoiceIdentity(companyId));

  return res.toString();
}

/** No-answer / busy / failed → short voicemail prompt, then hang up. */
export function buildVoicemailTwiml(): string {
  const res = new twilio.twiml.VoiceResponse();
  res.say(
    { voice: 'alice' },
    'Sorry, no agent is available right now. Please leave a message after the tone, or try again later.',
  );
  res.hangup();
  return res.toString();
}
