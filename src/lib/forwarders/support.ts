/**
 * Forward an inbound message to the Support edge function (AI CS BPO
 * repo, supabase/functions/support-channel-inbound).
 *
 * Called from every inbound webhook handler (whatsapp / instagram /
 * line / email) after `insertMessage()` succeeds. No-op for accounts
 * whose `delivery_target` is anything other than 'support' — that
 * keeps the BPO write path byte-identical for existing accounts.
 *
 * Fire-and-forget: webhook handlers ack 200 to Meta/LINE/etc. fast,
 * and a slow Support response shouldn't block that. We log failures
 * to stderr; the proxy doesn't retry on its own. (A follow-up could
 * push these onto QStash like the email-fetch flow if we ever see
 * dropped messages.)
 *
 * Env vars (must be set at deploy time):
 *   SUPPORT_WEBHOOK_URL    e.g. https://<proj>.supabase.co/functions/v1/support-channel-inbound
 *   SUPPORT_WEBHOOK_SECRET shared secret matching the edge function's
 *                          CHANNEL_PROXY_WEBHOOK_SECRET
 */

import type { NormalizedMessage } from '@/lib/adapters/types';

type ForwardableAccount = {
  readonly id: string;
  readonly company_id: string;
  readonly channel: string;
  readonly delivery_target?: string | null;
};

const SUPPORTED_CHANNELS = new Set(['whatsapp', 'instagram', 'line', 'email']);

export function forwardInboundToSupport(opts: {
  account: ForwardableAccount;
  msg: NormalizedMessage;
  conversationId: string;
}): void {
  const { account, msg, conversationId } = opts;
  if ((account.delivery_target ?? 'bpo') !== 'support') return;
  // Direction === 'inbound' only — outbound echoes (status updates,
  // adapter-side records of our own sends) should never be forwarded.
  if (msg.direction !== 'inbound') return;
  if (!SUPPORTED_CHANNELS.has(account.channel)) return;

  const url = process.env.SUPPORT_WEBHOOK_URL;
  const secret = process.env.SUPPORT_WEBHOOK_SECRET;
  if (!url || !secret) {
    console.warn(
      '[forwardInboundToSupport] SUPPORT_WEBHOOK_URL or SUPPORT_WEBHOOK_SECRET not set; skipping',
    );
    return;
  }

  const payload = {
    tenant_id: account.company_id,
    channel_account_id: account.id,
    conversation_id: conversationId,
    channel: account.channel,
    sender_handle: msg.channel_sender_id,
    sender_name: msg.sender_name || undefined,
    text: msg.text_body ?? '',
    // Rich-email fields — Support's edge function persists them when
    // present and the inbox renders html_body in a sandboxed iframe.
    html_body: msg.html_body ?? undefined,
    subject: msg.subject ?? undefined,
    message_id: msg.channel_message_id,
    received_at: msg.channel_timestamp,
  };

  // Fire-and-forget. Wrap in a Promise so a synchronous throw can't
  // crash the webhook handler. .catch is attached eagerly so an
  // unhandled rejection doesn't surface in serverless logs as a noisy
  // warning.
  void fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Webhook-Token': secret,
    },
    body: JSON.stringify(payload),
  })
    .then(async (res) => {
      if (res.ok) return;
      const body = await res.text().catch(() => '');
      console.warn(
        `[forwardInboundToSupport] ${res.status} on ${account.channel}/${account.id}: ${body.slice(0, 240)}`,
      );
    })
    .catch((err) => {
      console.warn(
        `[forwardInboundToSupport] network error on ${account.channel}/${account.id}:`,
        err instanceof Error ? err.message : err,
      );
    });
}
