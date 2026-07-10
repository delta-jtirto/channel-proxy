import { type NextRequest } from 'next/server';
import {
  getVoiceAccountByNumber,
  resolveTwilioCreds,
  insertWebhookLog,
  upsertContact,
  upsertConversation,
  bumpConversation,
  upsertCallMessage,
  refreshConversationPreview,
} from '@/lib/db/queries';
import { parseTwilioForm, verifyTwilioSignatureForAccount } from '@/lib/twilio';
import {
  mapTwilioCallStatus,
  formatCallPreviewMirror,
  resolveCallerContactId,
  callIdempotencyKey,
} from '@/lib/adapters/twilio-voice';

/**
 * POST: Twilio call-status callback — fires on ringing / in-progress /
 * completed / no-answer / busy / failed / canceled. Fields are
 * application/x-www-form-urlencoded (NOT JSON, unlike every chat webhook in
 * this repo) — Twilio's long-standing convention for all voice webhooks.
 *
 * Processed synchronously, matching the LINE/WhatsApp/email pattern (no
 * QStash) — a handful of Supabase round-trips comfortably fit Twilio's
 * webhook-ack budget.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ companyId: string }> },
) {
  const { companyId } = await params;

  const body = await parseTwilioForm(req);
  const toNumber = body.To ?? '';

  // Resolve WHICH of the company's voice numbers was dialed (email-style,
  // multi-number-per-company — see Architecture). Parsing the form to read
  // `To` before verifying is safe: the signature is computed over all params
  // incl. `To`, so a forged `To` pointing at another account fails the check
  // below unless the attacker also holds that account's token.
  const account = await getVoiceAccountByNumber(companyId, toNumber);
  if (!account) return new Response('Not Found', { status: 404 });

  // Delta-owned env creds by default; the row's own creds if a host BYO'd.
  const { authToken } = resolveTwilioCreds(account);
  if (!verifyTwilioSignatureForAccount(authToken, req, body)) {
    return new Response('Unauthorized', { status: 401 });
  }

  insertWebhookLog('voice', companyId, body).catch(() => {});

  // Plan 3 handles inbound only — outbound (agent-initiated) calls are
  // Plan 4/9's scope. Ack 200 either way so Twilio doesn't retry-storm.
  if (body.Direction && body.Direction !== 'inbound') {
    return new Response('OK', { status: 200 });
  }

  try {
    const callSid = body.CallSid;
    const from = body.From ?? '';
    const to = body.To ?? '';
    const callDuration = body.CallDuration ? Number.parseInt(body.CallDuration, 10) : null;
    const ourStatus = mapTwilioCallStatus(body.CallStatus ?? '', callDuration);
    const preview = formatCallPreviewMirror(ourStatus, callDuration, 'inbound');
    const nowIso = new Date().toISOString();
    const isTerminal = ourStatus === 'completed' || ourStatus === 'missed' || ourStatus === 'failed';

    const contactChannelId = resolveCallerContactId(from, callSid);
    const contactId = await upsertContact(companyId, 'voice', contactChannelId, null, null);

    const { id: conversationId, isNew: isNewConversation } = await upsertConversation(
      companyId,
      'voice',
      contactId,
      account.id,
      callSid,
      preview,
      null,
      'inbound',
    );

    const metadataPatch: Record<string, unknown> = {
      provider_call_id: callSid,
      status: ourStatus,
      from_number: from,
      to_number: to,
      ...(isTerminal ? { ended_at: nowIso, duration_sec: callDuration } : {}),
    };

    const { isNew: isNewMessage } = await upsertCallMessage({
      conversationId,
      companyId,
      channel: 'voice',
      direction: 'inbound',
      senderId: from,
      channelMessageId: callSid,
      idempotencyKey: callIdempotencyKey(callSid),
      textBody: preview,
      metadataPatch,
      channelTimestamp: nowIso,
    });

    if (isNewMessage) {
      // First event ever seen for this CallSid. upsertConversation's INSERT
      // already seeded counts=1 if the conversation itself is brand-new; a
      // repeat caller's conversation already existed, so bump it once here
      // (mirrors the exact isNew-gating every other channel already uses).
      if (!isNewConversation) await bumpConversation(conversationId, preview, 'inbound');
    } else {
      // A later lifecycle event on an already-counted call — refresh the
      // preview/timestamp only, do not increment message_count again.
      await refreshConversationPreview(conversationId, preview);
    }

    if (!account.last_webhook_at) {
      const { getServiceClient } = await import('@/lib/db/supabase');
      getServiceClient()
        .from('channel_accounts')
        .update({ last_webhook_at: nowIso })
        .eq('id', account.id)
        .then(() => {});
    }
  } catch (err) {
    console.error('Twilio voice-status webhook processing failed:', err);
  }

  return new Response('OK', { status: 200 });
}
