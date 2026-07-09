import { type NextRequest } from 'next/server';
import { insertWebhookLog } from '@/lib/db/queries';
import { parseTwilioForm, verifyTwilioSignature } from '@/lib/twilio';

/**
 * POST /api/webhooks/twilio/transcription
 *
 * Receives Twilio Real-Time Transcription status callbacks. We verify the
 * X-Twilio-Signature (reject 403 on mismatch) and ack 200 fast.
 *
 * Spike: payload capture only — Plan 3 maps these events onto CallRecord.
 * We don't yet know the exact field set Twilio sends (TranscriptionData,
 * TranscriptionEvent, Track, partial vs final, timing), so the whole job
 * of this route is to LEARN THE PAYLOAD: log it through the repo's
 * webhook_logs mechanism AND emit one structured console line for live
 * inspection during the spike run.
 */
export async function POST(req: NextRequest) {
  const params = await parseTwilioForm(req);

  if (!verifyTwilioSignature(req, params)) {
    return new Response('Forbidden', { status: 403 });
  }

  // Repo convention: persist raw webhook payloads to webhook_logs. No
  // company_id in the spike (no channel_accounts row yet) — pass null.
  // Fire-and-forget so a DB hiccup never delays the 200 ack.
  insertWebhookLog('twilio-transcription', null, params).catch(() => {});

  // Spike: payload capture only — Plan 3 maps these events onto CallRecord.
  console.info('[twilio-transcription] event', JSON.stringify(params));

  return new Response('OK', { status: 200 });
}
