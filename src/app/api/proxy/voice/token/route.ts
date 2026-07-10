import { NextResponse, type NextRequest } from 'next/server';
import twilio from 'twilio';
import { authenticateRequest, getUserCompanyIds } from '@/lib/auth/middleware';
import { getTwilioVoiceConfig, TOKEN_TTL_SECONDS } from '@/lib/twilio';
import { resolveVoiceIdentity } from '@/lib/adapters/twilio-answer';

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
 * Security: the token identity is the operator's company voice queue
 * (`voice:{companyId}`), derived server-side from the authenticated user —
 * NEVER read from the request body. company_id is the only trust boundary, so
 * a browser can only register a Device for its own company; a forged body
 * `identity` is ignored. The request needs no body.
 */
export async function POST(req: NextRequest) {
  const auth = await authenticateRequest(req);
  if ('error' in auth) return auth.error;

  const companyIds = await getUserCompanyIds(auth.user.id, auth.user.accessToken);
  if (companyIds.length === 0) {
    return NextResponse.json({ error: 'No company for operator' }, { status: 403 });
  }
  // Multi-company operators ring for their primary (first) company in v1.
  const identity = resolveVoiceIdentity(companyIds[0]);

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
