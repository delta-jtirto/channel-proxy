import { NextResponse, type NextRequest } from 'next/server';
import twilio from 'twilio';
import { authenticateRequest } from '@/lib/auth/middleware';
import { getTwilioVoiceConfig, TOKEN_TTL_SECONDS } from '@/lib/twilio';

interface VoiceTokenBody {
  /** The Twilio Client identity to mint the token for — e.g. the
   *  operator id whose browser softphone will register this Device. */
  identity?: string;
}

/**
 * POST /api/proxy/voice/token
 *
 * Mint a Twilio AccessToken (VoiceGrant) for the browser softphone. The
 * client SDK registers a Device under `identity` and, with
 * `incomingAllow: true`, can receive the `<Dial><Client>` leg from the
 * inbound voice webhook.
 *
 * Authenticated with a Supabase JWT Bearer token, matching the other
 * /api/proxy/* routes. Returns 503 (mirroring the WhatsApp embedded-signup
 * route) when Twilio is not configured.
 *
 * Spike scope: `identity` is validated non-empty only. Plan 3 should bind
 * it to the authenticated operator so a token can't be minted for someone
 * else's identity.
 */
export async function POST(req: NextRequest) {
  const auth = await authenticateRequest(req);
  if ('error' in auth) return auth.error;

  const body = (await req.json().catch(() => ({}))) as VoiceTokenBody;
  const identity = typeof body.identity === 'string' ? body.identity.trim() : '';
  if (!identity) {
    return NextResponse.json({ error: 'identity is required' }, { status: 400 });
  }

  const config = getTwilioVoiceConfig();
  if (!config) {
    return NextResponse.json(
      {
        error:
          'Voice not configured: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_API_KEY_SID, and TWILIO_API_KEY_SECRET must be set',
      },
      { status: 503 },
    );
  }

  const AccessToken = twilio.jwt.AccessToken;
  const VoiceGrant = AccessToken.VoiceGrant;

  // Inbound-only until the TwiML App exists. Once TWILIO_TWIML_APP_SID is
  // set, the same grant also authorizes outbound (browser-originated) calls.
  const voiceGrant = new VoiceGrant({
    incomingAllow: true,
    ...(config.twimlAppSid ? { outgoingApplicationSid: config.twimlAppSid } : {}),
  });

  const token = new AccessToken(
    config.accountSid,
    config.apiKeySid,
    config.apiKeySecret,
    { identity, ttl: TOKEN_TTL_SECONDS },
  );
  token.addGrant(voiceGrant);

  return NextResponse.json({
    token: token.toJwt(),
    identity,
    expires_in: TOKEN_TTL_SECONDS,
  });
}
