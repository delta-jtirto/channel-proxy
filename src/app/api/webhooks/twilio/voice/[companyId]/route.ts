import { type NextRequest } from 'next/server';
import { getVoiceAccountByNumber, resolveTwilioCreds } from '@/lib/db/queries';
import { parseTwilioForm, verifyTwilioSignatureForAccount, publicOrigin } from '@/lib/twilio';
import { buildAnswerTwiml, buildVoicemailTwiml } from '@/lib/adapters/twilio-answer';

const xml = (body: string) =>
  new Response(body, { headers: { 'Content-Type': 'text/xml' } });

/**
 * Inbound voice-answer webhook (the number's Voice URL points here).
 * Two stages on ONE route, disambiguated by `?stage=`:
 *  - default (no stage): Twilio's initial request → return answer TwiML
 *    (start transcription + dial the company browser client).
 *  - `?stage=dial-result`: the `<Dial action>` callback → inspect
 *    DialCallStatus; return voicemail TwiML only when the dial did NOT connect.
 *
 * Node runtime (twilio pkg needs crypto for signature validation). Account is
 * resolved by the dialed `To` (email-style multi-number), like the Plan 3
 * status/recording routes.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ companyId: string }> },
) {
  const { companyId } = await params;
  const body = await parseTwilioForm(req);

  const toNumber = body.To ?? '';
  const account = await getVoiceAccountByNumber(companyId, toNumber);
  if (!account) return new Response('Not Found', { status: 404 });

  const { authToken } = resolveTwilioCreds(account);
  if (!verifyTwilioSignatureForAccount(authToken, req, body)) {
    return new Response('Unauthorized', { status: 401 });
  }

  const stage = req.nextUrl.searchParams.get('stage');
  if (stage === 'dial-result') {
    const dialStatus = body.DialCallStatus ?? '';
    // Only fall through to voicemail when the dial genuinely didn't connect.
    if (dialStatus === 'completed' || dialStatus === 'answered') {
      return xml('<Response/>');
    }
    return xml(buildVoicemailTwiml());
  }

  return xml(buildAnswerTwiml({ companyId, toNumber, origin: publicOrigin(req) }));
}
