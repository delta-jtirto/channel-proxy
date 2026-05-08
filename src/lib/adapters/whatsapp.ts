import { createHmac } from 'crypto';
import type {
  InboundAdapter,
  OutboundAdapter,
  NormalizedMessage,
  DecryptedCredentials,
  OutboundMessage,
  SendResult,
  Attachment,
  MessageContentType,
  StatusUpdate,
  MessageStatus,
} from './types';
import { registry } from './registry';

// ============================================================
// WhatsApp Cloud API Types (Meta)
// ============================================================

interface WhatsAppWebhookBody {
  object: string;
  entry?: WhatsAppEntry[];
}

interface WhatsAppEntry {
  id: string;
  changes?: WhatsAppChange[];
}

interface WhatsAppChange {
  value: {
    messaging_product: string;
    metadata: { display_phone_number: string; phone_number_id: string };
    contacts?: { profile: { name: string }; wa_id: string }[];
    messages?: WhatsAppMessage[];
    statuses?: WhatsAppStatus[];
  };
  field: string;
}

interface WhatsAppMessage {
  from: string;
  id: string;
  timestamp: string;
  type: string;
  text?: { body: string };
  image?: WhatsAppMedia;
  video?: WhatsAppMedia;
  audio?: WhatsAppMedia;
  document?: WhatsAppMedia & { filename?: string };
  sticker?: WhatsAppMedia;
  location?: { latitude: number; longitude: number; name?: string; address?: string };
  reaction?: { message_id: string; emoji: string };
  interactive?: { type: string; button_reply?: { id: string; title: string }; list_reply?: { id: string; title: string } };
  context?: { from: string; id: string };
}

interface WhatsAppMedia {
  id: string;
  mime_type?: string;
  sha256?: string;
  caption?: string;
}

interface WhatsAppStatus {
  id: string;
  status: string;
  timestamp: string;
  recipient_id: string;
  errors?: { code: number; title?: string; message?: string }[];
}

// ============================================================
// Inbound Adapter
// ============================================================

const whatsappInbound: InboundAdapter = {
  channel: 'whatsapp',

  async verifyWebhook(req: Request, secret: string): Promise<boolean> {
    const signature = req.headers.get('x-hub-signature-256');
    if (!signature) return false;

    const body = await req.clone().text();
    const expectedSig =
      'sha256=' +
      createHmac('sha256', secret).update(body).digest('hex');

    return signature === expectedSig;
  },

  handleChallenge(req: Request, verifyToken: string): Response {
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
    const data = body as WhatsAppWebhookBody;
    if (data.object !== 'whatsapp_business_account') return [];

    const messages: NormalizedMessage[] = [];

    for (const entry of data.entry ?? []) {
      for (const change of entry.changes ?? []) {
        if (change.field !== 'messages') continue;

        const { contacts, messages: waMessages } = change.value;
        if (!waMessages) continue;

        for (const msg of waMessages) {
          const contact = contacts?.find((c) => c.wa_id === msg.from);
          const contentType = mapWhatsAppType(msg.type);
          const attachments = extractAttachments(msg);

          messages.push({
            channel: 'whatsapp',
            direction: 'inbound',
            company_id: companyId,
            channel_thread_id: msg.from, // WA threads are per-phone-number
            channel_sender_id: msg.from,
            sender_name: contact?.profile?.name ?? msg.from,
            sender_role: 'contact',
            content_type: contentType,
            text_body: msg.text?.body ?? msg.image?.caption ?? msg.video?.caption ?? msg.document?.caption ?? null,
            attachments,
            metadata: {
              wa_message_type: msg.type,
              ...(msg.context ? { reply_to: msg.context.id } : {}),
              ...(msg.reaction ? { reaction: msg.reaction.emoji, reaction_to: msg.reaction.message_id } : {}),
              ...(msg.location ? { location: msg.location } : {}),
            },
            channel_message_id: msg.id,
            channel_timestamp: new Date(parseInt(msg.timestamp) * 1000).toISOString(),
            idempotency_key: `whatsapp_${msg.id}`,
          });
        }
      }
    }

    return messages;
  },

  parseStatuses(body: unknown): StatusUpdate[] {
    const data = body as WhatsAppWebhookBody;
    if (data.object !== 'whatsapp_business_account') return [];

    const updates: StatusUpdate[] = [];
    for (const entry of data.entry ?? []) {
      for (const change of entry.changes ?? []) {
        if (change.field !== 'messages') continue;
        for (const s of change.value.statuses ?? []) {
          const mapped = mapWhatsAppStatus(s.status);
          if (!mapped) continue;
          const errMsg = s.errors?.length
            ? s.errors.map(e => `[${e.code}] ${e.title ?? e.message ?? ''}`.trim()).join('; ')
            : undefined;
          updates.push({
            channel_message_id: s.id,
            status: mapped,
            error_message: errMsg,
            channel_timestamp: new Date(parseInt(s.timestamp, 10) * 1000).toISOString(),
          });
        }
      }
    }
    return updates;
  },
};

function mapWhatsAppStatus(s: string): MessageStatus | null {
  switch (s) {
    case 'sent': return 'sent';
    case 'delivered': return 'delivered';
    case 'read': return 'read';
    case 'failed': return 'failed';
    default: return null;
  }
}

function mapWhatsAppType(type: string): MessageContentType {
  const map: Record<string, MessageContentType> = {
    text: 'text',
    image: 'image',
    video: 'video',
    audio: 'audio',
    document: 'file',
    sticker: 'sticker',
    location: 'location',
    interactive: 'interactive',
    reaction: 'text', // reactions stored as metadata
  };
  return map[type] ?? 'text';
}

function extractAttachments(msg: WhatsAppMessage): Attachment[] {
  const media =
    msg.image ?? msg.video ?? msg.audio ?? msg.document ?? msg.sticker;
  if (!media) return [];

  return [
    {
      type: msg.type,
      url: media.id, // Media ID — needs to be fetched via GET /{media_id}
      mime_type: media.mime_type,
      filename: (msg.document as WhatsAppMedia & { filename?: string })?.filename,
    },
  ];
}

// ============================================================
// Outbound Adapter
// ============================================================

const GRAPH_API_BASE = 'https://graph.facebook.com/v21.0';

const whatsappOutbound: OutboundAdapter = {
  channel: 'whatsapp',

  async send(
    creds: DecryptedCredentials,
    msg: OutboundMessage,
    contactPhoneNumber: string,
  ): Promise<SendResult> {
    const phoneNumberId = creds.phone_number_id as string;
    const accessToken = creds.access_token as string;

    const payload: Record<string, unknown> = {
      messaging_product: 'whatsapp',
      to: contactPhoneNumber,
      type: 'text',
      text: { body: msg.text },
    };

    // If there are image attachments, send as image message
    if (msg.attachments?.length && msg.attachments[0].type === 'image') {
      payload.type = 'image';
      payload.image = {
        link: msg.attachments[0].url,
        caption: msg.text || undefined,
      };
      delete payload.text;
    }

    const response = await fetch(
      `${GRAPH_API_BASE}/${phoneNumberId}/messages`,
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
        error_message: `WhatsApp API error ${response.status}: ${JSON.stringify(errorData)}`,
      };
    }

    const result = (await response.json()) as { messages?: { id: string }[] };
    return {
      channel_message_id: result.messages?.[0]?.id ?? '',
      status: 'sent',
    };
  },

  async markRead(
    creds: DecryptedCredentials,
    messageId: string,
  ): Promise<void> {
    const phoneNumberId = creds.phone_number_id as string;
    const accessToken = creds.access_token as string;

    await fetch(`${GRAPH_API_BASE}/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: messageId,
      }),
    });
  },
};

// Register both adapters
registry.register(whatsappInbound, whatsappOutbound);

export { whatsappInbound, whatsappOutbound };
