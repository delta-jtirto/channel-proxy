import twilio from 'twilio';
import { type NextRequest } from 'next/server';

/**
 * Twilio Voice/Video — shared helpers for the phone spike.
 *
 * Serverless-first: Twilio-native Real-Time Transcription delivers the
 * transcript via webhook POSTs, so there is no persistent WebSocket and
 * no new long-running service. Everything here runs inside ordinary
 * App Router route handlers (Node runtime — the `twilio` package needs
 * `crypto`, so these routes must NOT opt into the edge runtime).
 *
 * Design doc: AI CS BPO repo → docs/plans/2026-07-08-voice-video-channel-plan.md
 */

/**
 * Fixed spike identity. The browser softphone (built later in the BPO
 * repo) registers a Twilio Device under this identity, and the inbound
 * voice webhook dials `<Client>spike-agent</Client>` so the agent's
 * browser rings. Plan 3 replaces this constant with a real
 * operator-routing lookup (which agent owns this number / conversation).
 */
export const SPIKE_AGENT_IDENTITY = 'spike-agent';

/** Access-token lifetime. Twilio's own default is 3600s (1 hour). */
export const TOKEN_TTL_SECONDS = 3600;

export interface TwilioVoiceConfig {
  accountSid: string;
  authToken: string;
  apiKeySid: string;
  apiKeySecret: string;
  /** Empty until the TwiML App is created (outbound is out of scope for
   *  the inbound-only spike). */
  twimlAppSid: string | null;
  phoneNumber: string | null;
}

/**
 * Read Twilio config from env. Returns null when a REQUIRED var is
 * missing so callers can 503 the same way the WhatsApp embedded-signup
 * route does for META_APP_ID / META_APP_SECRET.
 *
 * `twimlAppSid` and `phoneNumber` are optional — the inbound-only spike
 * mints incoming-only tokens without them.
 */
export function getTwilioVoiceConfig(): TwilioVoiceConfig | null {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const apiKeySid = process.env.TWILIO_API_KEY_SID;
  const apiKeySecret = process.env.TWILIO_API_KEY_SECRET;
  if (!accountSid || !authToken || !apiKeySid || !apiKeySecret) return null;
  return {
    accountSid,
    authToken,
    apiKeySid,
    apiKeySecret,
    twimlAppSid: process.env.TWILIO_TWIML_APP_SID || null,
    phoneNumber: process.env.TWILIO_PHONE_NUMBER || null,
  };
}

/**
 * The public origin (`scheme://host`) that the outside world — Twilio,
 * or ngrok in front of `next dev` — used to reach us. Behind a proxy the
 * internal `req.nextUrl` host is not the public host, so prefer the
 * forwarded headers. Vercel and ngrok both set `x-forwarded-proto` /
 * `x-forwarded-host`.
 */
export function publicOrigin(req: NextRequest): string {
  const proto =
    req.headers.get('x-forwarded-proto') ?? req.nextUrl.protocol.replace(':', '');
  const host =
    req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? req.nextUrl.host;
  return `${proto}://${host}`;
}

/**
 * The full public URL (with path + query) Twilio signed against. Twilio
 * computes X-Twilio-Signature over this exact string, so it must match
 * the webhook URL configured in the Twilio Console byte-for-byte.
 */
export function publicUrl(req: NextRequest): string {
  return `${publicOrigin(req)}${req.nextUrl.pathname}${req.nextUrl.search}`;
}

/**
 * Read a Twilio webhook's `application/x-www-form-urlencoded` body into a
 * plain params object. Consumes the request body, so call it once and
 * reuse the result for both signature validation and handling.
 */
export async function parseTwilioForm(
  req: NextRequest,
): Promise<Record<string, string>> {
  const form = await req.formData();
  const params: Record<string, string> = {};
  for (const [key, value] of form.entries()) {
    if (typeof value === 'string') params[key] = value;
  }
  return params;
}

/**
 * Validate the `X-Twilio-Signature` header against the reconstructed
 * public URL and the POSTed form params. Returns false on a missing auth
 * token, a missing signature header, or a mismatch — callers reject 403.
 */
export function verifyTwilioSignature(
  req: NextRequest,
  params: Record<string, string>,
): boolean {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) return false;
  const signature = req.headers.get('x-twilio-signature');
  if (!signature) return false;
  return twilio.validateRequest(authToken, signature, publicUrl(req), params);
}
