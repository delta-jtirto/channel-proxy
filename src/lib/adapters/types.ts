// ============================================================
// Channel Adapter Interfaces & Shared Types
// ============================================================

export type Channel = 'whatsapp' | 'instagram' | 'line' | 'email' | 'telegram' | 'wati';

export type MessageDirection = 'inbound' | 'outbound';

export type MessageContentType =
  | 'text'
  | 'image'
  | 'video'
  | 'audio'
  | 'file'
  | 'location'
  | 'sticker'
  | 'template'
  | 'interactive';

export type MessageStatus =
  | 'received'
  | 'sent'
  | 'delivered'
  | 'read'
  | 'failed';

export interface Attachment {
  type: string; // "image" | "video" | "audio" | "file"
  url: string; // original URL from channel
  stored_url?: string; // after upload to storage
  mime_type?: string;
  filename?: string;
  size_bytes?: number;
}

export interface NormalizedMessage {
  channel: Channel;
  direction: MessageDirection;
  company_id: string;

  // Thread identity
  channel_thread_id: string;

  // Sender
  channel_sender_id: string;
  sender_name: string;
  sender_role: 'contact' | 'company' | 'system';

  // Content
  content_type: MessageContentType;
  text_body: string | null;
  html_body?: string | null; // email HTML body (email channel only)
  subject?: string | null; // email subject
  attachments: Attachment[];
  metadata: Record<string, unknown>; // channel-specific extras

  // Tracking
  channel_message_id: string;
  channel_timestamp: string; // ISO timestamp
  idempotency_key: string; // "{channel}_{channel_msg_id}"
}

export interface OutboundMessage {
  conversation_id: string;
  text: string;
  content_type?: MessageContentType;
  attachments?: Attachment[];
  metadata?: Record<string, unknown>;
}

export interface SendResult {
  channel_message_id: string;
  status: MessageStatus;
  error_message?: string;
}

export interface DecryptedCredentials {
  [key: string]: unknown;
}

// ============================================================
// Adapter Interfaces
// ============================================================

/** Delivery status update for an outbound message we previously sent.
 *  Channels that report delivery state (WhatsApp, Wati) emit these alongside
 *  inbound messages on the same webhook. We use them to flip the row from
 *  'sent' (= accepted by API) to 'delivered'/'read'/'failed' (= reality). */
export interface StatusUpdate {
  channel_message_id: string;
  status: MessageStatus;
  error_message?: string;
  /** Provider event timestamp (ISO). For ordering when multiple updates race. */
  channel_timestamp: string;
}

export interface InboundAdapter {
  channel: Channel;

  /** Verify the webhook signature/auth. Returns true if valid. */
  verifyWebhook(req: Request, secret: string): Promise<boolean>;

  /** Parse a webhook payload into normalized messages. */
  parseWebhook(body: unknown, companyId: string): NormalizedMessage[];

  /** Parse delivery-status events for previously-sent outbound messages.
   *  Optional — only WhatsApp and Wati emit these. */
  parseStatuses?(body: unknown, companyId: string): StatusUpdate[];

  /** Handle a webhook verification challenge (Meta GET requests). */
  handleChallenge?(req: Request, verifyToken: string): Response;
}

export interface OutboundAdapter {
  channel: Channel;

  /** Send a message via the channel API. */
  send(
    creds: DecryptedCredentials,
    msg: OutboundMessage,
    contactChannelId: string,
  ): Promise<SendResult>;

  /** Mark a message as read on the channel (if supported). */
  markRead?(
    creds: DecryptedCredentials,
    messageId: string,
  ): Promise<void>;
}
