import { createHmac } from 'crypto';
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
// Instagram Messaging API Types (Meta Graph API)
// Shares webhook infra with WhatsApp (same HMAC-SHA256, same challenge)
// ============================================================

interface InstagramWebhookBody {
  object: string;
  entry?: InstagramEntry[];
}

interface InstagramEntry {
  id: string;
  time: number;
  messaging?: InstagramMessaging[];
}

interface InstagramMessaging {
  sender: { id: string };
  recipient: { id: string };
  timestamp: number;
  message?: {
    mid: string;
    text?: string;
    attachments?: { type: string; payload: { url: string } }[];
    is_echo?: boolean;
    reply_to?: { mid: string };
  };
  read?: { watermark: number };
}

// ============================================================
// Inbound Adapter
// ============================================================

const instagramInbound: InboundAdapter = {
  channel: 'instagram',

  async verifyWebhook(req: Request, secret: string): Promise<boolean> {
    // Same HMAC-SHA256 as WhatsApp (shared Meta platform)
    const signature = req.headers.get('x-hub-signature-256');
    if (!signature) return false;

    const body = await req.clone().text();
    const expectedSig =
      'sha256=' +
      createHmac('sha256', secret).update(body).digest('hex');

    return signature === expectedSig;
  },

  handleChallenge(req: Request, verifyToken: string): Response {
    // Same challenge flow as WhatsApp
    const url = new URL(req.url);
    const mode = url.searchParams.get('hub.mode');
    const token = url.searchParams.get('hub.verify_token');
    const challenge = url.searchParams.get('hub.challenge');

    if (mode === 'subscribe' && token === verifyToken) {
      return new Response(challenge, { status: 200 });
    }
    return new Response('Forbidden', { status: 403 });
  },

  parseWebhook(body: unknown, companyId: string): NormalizedMessage[] {
    const data = body as InstagramWebhookBody;
    if (data.object !== 'instagram') return [];

    const messages: NormalizedMessage[] = [];

    for (const entry of data.entry ?? []) {
      for (const event of entry.messaging ?? []) {
        // Skip echoes (messages sent by us) and read receipts
        if (!event.message || event.message.is_echo) continue;

        const msg = event.message;
        const hasAttachments = msg.attachments && msg.attachments.length > 0;
        const contentType: MessageContentType = hasAttachments
          ? mapAttachmentType(msg.attachments![0].type)
          : 'text';

        messages.push({
          channel: 'instagram',
          direction: 'inbound',
          company_id: companyId,
          channel_thread_id: event.sender.id, // IG threads are per-user
          channel_sender_id: event.sender.id,
          sender_name: event.sender.id, // IG doesn't provide name in webhook
          sender_role: 'contact',
          content_type: contentType,
          text_body: msg.text ?? null,
          attachments: (msg.attachments ?? []).map((a) => ({
            type: a.type,
            url: a.payload.url,
            mime_type: undefined,
          })),
          metadata: {
            ig_mid: msg.mid,
            ...(msg.reply_to ? { reply_to: msg.reply_to.mid } : {}),
          },
          channel_message_id: msg.mid,
          channel_timestamp: new Date(event.timestamp).toISOString(),
          idempotency_key: `instagram_${msg.mid}`,
        });
      }
    }

    return messages;
  },
};

function mapAttachmentType(type: string): MessageContentType {
  const map: Record<string, MessageContentType> = {
    image: 'image',
    video: 'video',
    audio: 'audio',
    file: 'file',
  };
  return map[type] ?? 'file';
}

// ============================================================
// Outbound Adapter
// ============================================================

const GRAPH_API_BASE = 'https://graph.facebook.com/v21.0';

const instagramOutbound: OutboundAdapter = {
  channel: 'instagram',

  async send(
    creds: DecryptedCredentials,
    msg: OutboundMessage,
    contactIgUserId: string,
  ): Promise<SendResult> {
    const igUserId = creds.ig_user_id as string;
    const accessToken = creds.access_token as string;

    const payload: Record<string, unknown> = {
      recipient: { id: contactIgUserId },
      message: { text: msg.text },
    };

    // If there's an image attachment, send as image
    if (msg.attachments?.length && msg.attachments[0].type === 'image') {
      payload.message = {
        attachment: {
          type: 'image',
          payload: { url: msg.attachments[0].url },
        },
      };
    }

    const response = await fetch(
      `${GRAPH_API_BASE}/${igUserId}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      },
    );

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      return {
        channel_message_id: '',
        status: 'failed',
        error_message: `Instagram API error ${response.status}: ${JSON.stringify(errorData)}`,
      };
    }

    const result = (await response.json()) as { message_id?: string };
    return {
      channel_message_id: result.message_id ?? '',
      status: 'sent',
    };
  },
};

registry.register(instagramInbound, instagramOutbound);

export { instagramInbound, instagramOutbound };
