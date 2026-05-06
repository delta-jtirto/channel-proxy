// Wati BSP adapter — wraps WhatsApp Cloud API behind Wati's tenant API.
//
// Stored as channel='wati' in channel_accounts so it routes independently
// from the Meta-direct WhatsApp adapter. Visually treated as WhatsApp on
// the frontend.
//
// Credentials shape:
//   { api_endpoint: 'https://live-mt-server.wati.io/{tenantId}/',
//     access_token: 'wati_xxx...' }
//
// Wati doesn't sign webhooks. We rely on the per-company webhook URL
// containing a non-guessable company_id; for production add a shared
// secret query param.

import type {
  InboundAdapter,
  OutboundAdapter,
  NormalizedMessage,
  DecryptedCredentials,
  OutboundMessage,
  SendResult,
  MessageContentType,
} from './types';
import { registry } from './registry';

// ============================================================
// Wati webhook payload (inbound)
// Reference: https://docs.wati.io (webhook payloads)
// ============================================================

interface WatiWebhookBody {
  id?: string;
  whatsappMessageId?: string;
  conversationId?: string;
  text?: string;
  type?: string; // text | image | video | audio | document | sticker | location | reaction
  data?: string | null; // media URL / data
  sourceUrl?: string | null;
  timestamp?: string | number;
  owner?: boolean; // false = inbound from customer; true = outbound from business
  eventType?: string; // 'message' | 'sessionMessageSent' | 'templateMessageSent' | 'messageStatus' | etc
  senderName?: string;
  waId?: string; // customer's WhatsApp number (no +)
  messageContextInfo?: { stanzaId?: string } | null;
}

const watiInbound: InboundAdapter = {
  channel: 'wati',

  // Wati doesn't HMAC-sign webhooks. Treat any POST that looks valid as authentic.
  // (Production-hardening: add a shared secret query param to the webhook URL
  // and validate it here.)
  async verifyWebhook(): Promise<boolean> {
    return true;
  },

  parseWebhook(body: unknown, companyId: string): NormalizedMessage[] {
    const data = body as WatiWebhookBody;

    // Only handle inbound customer messages. owner=true is our own outbound
    // echo; status events have eventType !== 'message'.
    if (data.eventType !== 'message') return [];
    if (data.owner === true) return [];
    if (!data.waId) return [];

    const channelMessageId = data.whatsappMessageId || data.id || '';
    if (!channelMessageId) return [];

    const ts = data.timestamp;
    const isoTs = typeof ts === 'number'
      ? new Date(ts * 1000).toISOString()
      : ts && /^\d+$/.test(String(ts))
        ? new Date(parseInt(String(ts), 10) * 1000).toISOString()
        : ts
          ? new Date(String(ts)).toISOString()
          : new Date().toISOString();

    const contentType = mapWatiType(data.type);
    const attachments = data.data && data.type && data.type !== 'text'
      ? [{
          type: data.type,
          url: data.sourceUrl || data.data,
          mime_type: undefined as string | undefined,
        }]
      : [];

    return [{
      channel: 'wati',
      direction: 'inbound',
      company_id: companyId,
      channel_thread_id: data.waId,
      channel_sender_id: data.waId,
      sender_name: data.senderName || data.waId,
      sender_role: 'contact',
      content_type: contentType,
      text_body: data.text ?? null,
      attachments,
      metadata: {
        wati_event: data.eventType,
        wati_type: data.type,
        ...(data.conversationId ? { wati_conversation_id: data.conversationId } : {}),
        ...(data.messageContextInfo?.stanzaId ? { reply_to: data.messageContextInfo.stanzaId } : {}),
      },
      channel_message_id: channelMessageId,
      channel_timestamp: isoTs,
      idempotency_key: `wati_${channelMessageId}`,
    }];
  },
};

function mapWatiType(type?: string): MessageContentType {
  switch (type) {
    case 'image': return 'image';
    case 'video': return 'video';
    case 'audio': return 'audio';
    case 'document': return 'file';
    case 'sticker': return 'sticker';
    case 'location': return 'location';
    case 'interactive': return 'interactive';
    default: return 'text';
  }
}

// ============================================================
// Outbound: send via Wati API
// ============================================================
//
// Wati v1 endpoint: POST {endpoint}api/v1/sendSessionMessage/{whatsappNumber}
//   Body: { messageText: string }
//   Headers: Authorization: Bearer {token}
//
// "Session" messages work only inside the 24h customer-service window.
// Outside it, only approved templates may be sent (sendTemplateMessage).
// We surface Wati's error verbatim so the caller can react.

const watiOutbound: OutboundAdapter = {
  channel: 'wati',

  async send(
    creds: DecryptedCredentials,
    msg: OutboundMessage,
    contactPhoneNumber: string,
  ): Promise<SendResult> {
    const rawEndpoint = (creds.api_endpoint as string | undefined) || '';
    const token = creds.access_token as string | undefined;
    if (!rawEndpoint || !token) {
      return { channel_message_id: '', status: 'failed', error_message: 'Wati credentials missing api_endpoint or access_token' };
    }

    // Normalize: ensure single trailing slash on the tenant base
    const base = rawEndpoint.replace(/\/+$/, '') + '/';
    const url = `${base}api/v1/sendSessionMessage/${encodeURIComponent(contactPhoneNumber)}`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ messageText: msg.text }),
      });
    } catch (err) {
      return {
        channel_message_id: '',
        status: 'failed',
        error_message: `Wati network error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const json = (await response.json().catch(() => ({}))) as {
      result?: boolean;
      message?: { whatsappMessageId?: string; id?: string };
      info?: string;
      error?: string | { message?: string };
    };

    if (!response.ok || json.result === false) {
      const errMsg = typeof json.error === 'string'
        ? json.error
        : json.error?.message || json.info || `HTTP ${response.status}`;
      return {
        channel_message_id: '',
        status: 'failed',
        error_message: `Wati API error: ${errMsg}`,
      };
    }

    return {
      channel_message_id: json.message?.whatsappMessageId || json.message?.id || '',
      status: 'sent',
    };
  },
};

registry.register(watiInbound, watiOutbound);

export { watiInbound, watiOutbound };
