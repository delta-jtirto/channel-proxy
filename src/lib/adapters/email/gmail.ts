import { google } from 'googleapis';
import type {
  InboundAdapter,
  OutboundAdapter,
  NormalizedMessage,
  DecryptedCredentials,
  OutboundMessage,
  SendResult,
} from '../types';
import { registry } from '../registry';

// ============================================================
// Gmail OAuth + API adapter
// Uses Gmail API for both read and send.
// Inbound: Google Pub/Sub push notification -> fetch full message.
// ============================================================

function getOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI,
  );
}

// ============================================================
// OAuth Helpers
// ============================================================

/** Generate the OAuth consent URL for Gmail access. */
export function getGmailAuthUrl(state: string): string {
  const oauth2Client = getOAuth2Client();
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/userinfo.email',
    ],
    state,
  });
}

/** Exchange authorization code for tokens. */
export async function exchangeGmailCode(code: string) {
  const oauth2Client = getOAuth2Client();
  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);

  // Get user email
  const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
  const { data: userInfo } = await oauth2.userinfo.get();

  return {
    refresh_token: tokens.refresh_token!,
    access_token: tokens.access_token!,
    email_address: userInfo.email!,
    provider: 'gmail' as const,
  };
}

/** Register Gmail push notifications via watch(). Expires in 7 days. */
export async function registerGmailWatch(refreshToken: string) {
  const oauth2Client = getOAuth2Client();
  oauth2Client.setCredentials({ refresh_token: refreshToken });

  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
  const { data } = await gmail.users.watch({
    userId: 'me',
    requestBody: {
      topicName: process.env.GOOGLE_PUBSUB_TOPIC!,
      labelIds: ['INBOX'],
    },
  });

  return data;
}

/** Fetch a full email message by history ID (from Pub/Sub notification). */
export async function fetchNewMessages(
  refreshToken: string,
  historyId: string,
) {
  const oauth2Client = getOAuth2Client();
  oauth2Client.setCredentials({ refresh_token: refreshToken });

  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

  // Get history since the notification
  const { data: history } = await gmail.users.history.list({
    userId: 'me',
    startHistoryId: historyId,
    historyTypes: ['messageAdded'],
  });

  const messageIds: string[] = [];
  for (const h of history.history ?? []) {
    for (const added of h.messagesAdded ?? []) {
      if (added.message?.id) messageIds.push(added.message.id);
    }
  }

  // Fetch full messages
  const messages = [];
  for (const msgId of messageIds) {
    const { data } = await gmail.users.messages.get({
      userId: 'me',
      id: msgId,
      format: 'full',
    });
    messages.push(data);
  }

  return messages;
}

// ============================================================
// Parse Gmail message into NormalizedMessage
// ============================================================

function getHeader(
  headers: { name?: string | null; value?: string | null }[] | undefined,
  name: string,
): string {
  return headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? '';
}

function extractTextBody(payload: { mimeType?: string | null; body?: { data?: string | null }; parts?: typeof payload[] }): string {
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64url').toString('utf8');
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      const text = extractTextBody(part as typeof payload);
      if (text) return text;
    }
  }
  return '';
}

export function parseGmailMessage(
  gmailMsg: { id?: string | null; threadId?: string | null; payload?: { headers?: { name?: string | null; value?: string | null }[]; mimeType?: string | null; body?: { data?: string | null }; parts?: unknown[] } },
  companyId: string,
): NormalizedMessage | null {
  const headers = gmailMsg.payload?.headers;
  const from = getHeader(headers, 'From');
  const subject = getHeader(headers, 'Subject');
  const messageId = getHeader(headers, 'Message-ID');
  const date = getHeader(headers, 'Date');

  // Extract email address from "Name <email@example.com>" format
  const emailMatch = from.match(/<(.+?)>/) ?? [null, from];
  const senderEmail = emailMatch[1] ?? from;
  const senderName = from.replace(/<.*?>/, '').trim() || senderEmail;

  const textBody = extractTextBody(gmailMsg.payload as Parameters<typeof extractTextBody>[0]);

  if (!senderEmail || !textBody) return null;

  return {
    channel: 'email',
    direction: 'inbound',
    company_id: companyId,
    channel_thread_id: gmailMsg.threadId ?? gmailMsg.id ?? '',
    channel_sender_id: senderEmail,
    sender_name: senderName,
    sender_role: 'contact',
    content_type: 'text',
    text_body: textBody,
    subject,
    attachments: [],
    metadata: {
      gmail_message_id: gmailMsg.id,
      gmail_thread_id: gmailMsg.threadId,
      message_id_header: messageId,
      provider: 'gmail',
    },
    channel_message_id: gmailMsg.id ?? '',
    channel_timestamp: date ? new Date(date).toISOString() : new Date().toISOString(),
    idempotency_key: `email_gmail_${gmailMsg.id}`,
  };
}

// ============================================================
// Inbound Adapter (Pub/Sub push notifications)
// ============================================================

interface GmailPubSubPayload {
  message: {
    data: string; // base64-encoded JSON: { emailAddress, historyId }
    messageId: string;
    publishTime: string;
  };
  subscription: string;
}

const emailInbound: InboundAdapter = {
  channel: 'email',

  async verifyWebhook(): Promise<boolean> {
    // Google Pub/Sub push uses a bearer token or we verify the subscription
    // For POC, accept all — production should verify the Pub/Sub push token
    return true;
  },

  parseWebhook(body: unknown, companyId: string): NormalizedMessage[] {
    // Pub/Sub push sends { message: { data: base64 } }
    // The actual email fetching happens in the webhook route handler
    // since it requires async Gmail API calls with credentials.
    // This adapter just extracts the notification metadata.
    const data = body as GmailPubSubPayload;
    if (!data.message?.data) return [];

    const decoded = JSON.parse(
      Buffer.from(data.message.data, 'base64').toString('utf8'),
    ) as { emailAddress: string; historyId: string };

    // Return a "marker" message that the worker will use to fetch actual emails
    return [
      {
        channel: 'email',
        direction: 'inbound',
        company_id: companyId,
        channel_thread_id: '',
        channel_sender_id: decoded.emailAddress,
        sender_name: decoded.emailAddress,
        sender_role: 'system',
        content_type: 'text',
        text_body: null,
        attachments: [],
        metadata: {
          type: 'gmail_push_notification',
          history_id: decoded.historyId,
          email_address: decoded.emailAddress,
        },
        channel_message_id: data.message.messageId,
        channel_timestamp: data.message.publishTime,
        idempotency_key: `email_push_${data.message.messageId}`,
      },
    ];
  },
};

// ============================================================
// Outbound Adapter (send via Gmail API)
// ============================================================

const emailOutbound: OutboundAdapter = {
  channel: 'email',

  async send(
    creds: DecryptedCredentials,
    msg: OutboundMessage,
    recipientEmail: string,
  ): Promise<SendResult> {
    const refreshToken = creds.refresh_token as string;
    const senderEmail = creds.email_address as string;

    const oauth2Client = getOAuth2Client();
    oauth2Client.setCredentials({ refresh_token: refreshToken });

    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

    // Build RFC 2822 email
    const subject = msg.metadata?.subject as string ?? 'Re: Your message';
    const raw = [
      `From: ${senderEmail}`,
      `To: ${recipientEmail}`,
      `Subject: ${subject}`,
      `Content-Type: text/plain; charset=utf-8`,
      '',
      msg.text,
    ].join('\r\n');

    const encodedMessage = Buffer.from(raw)
      .toString('base64url');

    const sendParams: { userId: string; requestBody: { raw: string; threadId?: string } } = {
      userId: 'me',
      requestBody: { raw: encodedMessage },
    };

    // Thread the reply if we have a thread ID
    if (msg.metadata?.gmail_thread_id) {
      sendParams.requestBody.threadId = msg.metadata.gmail_thread_id as string;
    }

    const { data } = await gmail.users.messages.send(sendParams);

    return {
      channel_message_id: data.id ?? '',
      status: 'sent',
    };
  },
};

registry.register(emailInbound, emailOutbound);

export { emailInbound, emailOutbound };
