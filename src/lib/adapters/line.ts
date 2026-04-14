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
// LINE Messaging API Types
// ============================================================

interface LineWebhookBody {
  destination: string;
  events: LineEvent[];
}

interface LineEvent {
  type: string;
  message?: LineMessage;
  timestamp: number;
  source: { type: string; userId?: string; groupId?: string; roomId?: string };
  replyToken?: string;
  webhookEventId: string;
}

interface LineMessage {
  id: string;
  type: string;
  text?: string;
  fileName?: string;
  fileSize?: number;
  contentProvider?: { type: string; originalContentUrl?: string; previewImageUrl?: string };
  latitude?: number;
  longitude?: number;
  address?: string;
  title?: string;
  packageId?: string;
  stickerId?: string;
}

// ============================================================
// Inbound Adapter
// ============================================================

const lineInbound: InboundAdapter = {
  channel: 'line',

  async verifyWebhook(req: Request, secret: string): Promise<boolean> {
    const signature = req.headers.get('x-line-signature');
    if (!signature) return false;

    const body = await req.clone().text();
    const expectedSig = createHmac('sha256', secret)
      .update(body)
      .digest('base64');

    return signature === expectedSig;
  },

  // LINE doesn't use a challenge flow like Meta
  handleChallenge: undefined,

  parseWebhook(body: unknown, companyId: string): NormalizedMessage[] {
    const data = body as LineWebhookBody;
    const messages: NormalizedMessage[] = [];

    for (const event of data.events ?? []) {
      if (event.type !== 'message' || !event.message) continue;

      const userId = event.source.userId;
      if (!userId) continue;

      const msg = event.message;
      const contentType = mapLineType(msg.type);

      messages.push({
        channel: 'line',
        direction: 'inbound',
        company_id: companyId,
        channel_thread_id: userId, // LINE threads are per-user
        channel_sender_id: userId,
        sender_name: userId, // Name fetched separately via Profile API if needed
        sender_role: 'contact',
        content_type: contentType,
        text_body: msg.text ?? null,
        attachments: buildLineAttachments(msg),
        metadata: {
          line_message_type: msg.type,
          reply_token: event.replyToken,
          webhook_event_id: event.webhookEventId,
          ...(msg.packageId ? { sticker_package_id: msg.packageId, sticker_id: msg.stickerId } : {}),
          ...(msg.latitude != null ? { location: { latitude: msg.latitude, longitude: msg.longitude, address: msg.address, title: msg.title } } : {}),
        },
        channel_message_id: msg.id,
        channel_timestamp: new Date(event.timestamp).toISOString(),
        idempotency_key: `line_${msg.id}`,
      });
    }

    return messages;
  },
};

function mapLineType(type: string): MessageContentType {
  const map: Record<string, MessageContentType> = {
    text: 'text',
    image: 'image',
    video: 'video',
    audio: 'audio',
    file: 'file',
    location: 'location',
    sticker: 'sticker',
  };
  return map[type] ?? 'text';
}

function buildLineAttachments(msg: LineMessage) {
  if (msg.type === 'text' || msg.type === 'location' || msg.type === 'sticker') {
    return [];
  }

  // For media messages, the content is fetched via LINE Content API
  // URL format: https://api-data.line.me/v2/bot/message/{messageId}/content
  return [
    {
      type: msg.type,
      url: `https://api-data.line.me/v2/bot/message/${msg.id}/content`,
      filename: msg.fileName,
      size_bytes: msg.fileSize,
    },
  ];
}

// ============================================================
// Outbound Adapter
// ============================================================

const LINE_API_BASE = 'https://api.line.me/v2/bot';

const lineOutbound: OutboundAdapter = {
  channel: 'line',

  async send(
    creds: DecryptedCredentials,
    msg: OutboundMessage,
    contactUserId: string,
  ): Promise<SendResult> {
    const accessToken = creds.channel_access_token as string;

    // Check if we have a reply token in metadata (free reply vs paid push)
    const replyToken = msg.metadata?.reply_token as string | undefined;

    const messages = [{ type: 'text', text: msg.text }];

    // If image attachment, send as image message
    if (msg.attachments?.length && msg.attachments[0].type === 'image') {
      messages[0] = {
        type: 'image',
        text: '', // not used but keeps TS happy
        ...({
          originalContentUrl: msg.attachments[0].url,
          previewImageUrl: msg.attachments[0].url,
        } as Record<string, string>),
      } as typeof messages[0];
    }

    let endpoint: string;
    let body: Record<string, unknown>;

    if (replyToken) {
      // Reply (free)
      endpoint = `${LINE_API_BASE}/message/reply`;
      body = { replyToken, messages };
    } else {
      // Push (costs against quota)
      endpoint = `${LINE_API_BASE}/message/push`;
      body = { to: contactUserId, messages };
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      return {
        channel_message_id: '',
        status: 'failed',
        error_message: `LINE API error ${response.status}: ${JSON.stringify(errorData)}`,
      };
    }

    // LINE doesn't return message IDs for sent messages
    const sentMessageId = `line_sent_${Date.now()}`;
    return {
      channel_message_id: sentMessageId,
      status: 'sent',
    };
  },
};

registry.register(lineInbound, lineOutbound);

export { lineInbound, lineOutbound };
