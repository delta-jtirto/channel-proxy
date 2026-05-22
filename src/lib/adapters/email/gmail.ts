import { OAuth2Client } from 'google-auth-library';
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
// Gmail OAuth + REST API adapter (lightweight, no googleapis SDK)
// ============================================================

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';

function getOAuth2Client() {
  return new OAuth2Client(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI,
  );
}

async function getAccessToken(refreshToken: string): Promise<string> {
  const client = getOAuth2Client();
  client.setCredentials({ refresh_token: refreshToken });
  const { token } = await client.getAccessToken();
  if (!token) throw new Error('Failed to get Gmail access token');
  return token;
}

// ============================================================
// OAuth Helpers
// ============================================================

export function getGmailAuthUrl(state: string): string {
  const client = getOAuth2Client();
  return client.generateAuthUrl({
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

export async function exchangeGmailCode(code: string) {
  const client = getOAuth2Client();
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);

  // Get user email via userinfo endpoint
  const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  const userInfo = (await res.json()) as { email: string };

  return {
    refresh_token: tokens.refresh_token!,
    access_token: tokens.access_token!,
    email_address: userInfo.email,
    provider: 'gmail' as const,
  };
}

export async function registerGmailWatch(refreshToken: string) {
  const topicName = process.env.GOOGLE_PUBSUB_TOPIC;
  if (!topicName) {
    throw new Error('GOOGLE_PUBSUB_TOPIC env var is not set');
  }
  const token = await getAccessToken(refreshToken);
  const res = await fetch(`${GMAIL_API}/watch`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      topicName,
      labelIds: ['INBOX'],
    }),
  });
  if (!res.ok) {
    // Surface the actual Google API error body — without it every watch
    // failure looks like a generic 400 and you can't tell whether it's
    // a missing topic, missing IAM grant, disabled API, etc.
    const body = await res.text().catch(() => '');
    throw new Error(`Gmail watch failed: ${res.status} ${body.slice(0, 600)}`);
  }
  return res.json();
}

export async function fetchNewMessages(refreshToken: string, historyId: string) {
  const token = await getAccessToken(refreshToken);

  // Gmail's history.list returns records AFTER startHistoryId (exclusive).
  // The Pub/Sub push contains the historyId of the change that just
  // happened, so passing it verbatim returns nothing — we'd be asking
  // for changes after the change itself. Subtract a small buffer so the
  // window includes the triggering event. 50 is well below Gmail's 7-day
  // history retention but generous enough to absorb the gap between the
  // push fire and our query, plus a few interleaved unrelated events.
  // Proper long-term fix: track a per-account last_history_id watermark
  // updated from watch()'s initial response and each successful fetch.
  // Buffer of 500 (was 50) — large enough to absorb interleaved
  // non-mail events (label changes, reads) between the last query and
  // the current push without ever going past Gmail's 7-day retention.
  const startNum = Math.max(1, (parseInt(historyId, 10) || 0) - 500);
  const startHistoryId = String(startNum);

  // Drop the historyTypes=messageAdded filter — Gmail occasionally
  // categorises new mail events under different history types and our
  // narrow filter was hiding them. We post-filter on .messagesAdded
  // below, which gives us the same selection without the API-side gate.
  const historyRes = await fetch(
    `${GMAIL_API}/history?startHistoryId=${startHistoryId}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!historyRes.ok) {
    const body = await historyRes.text().catch(() => '');
    console.warn(
      `[gmail.fetchNewMessages] history.list failed: ${historyRes.status} ${body.slice(0, 200)}`,
    );
    return [];
  }
  const rawJson = await historyRes.text();
  let history: { history?: { messagesAdded?: { message?: { id: string } }[] }[] };
  try {
    history = JSON.parse(rawJson);
  } catch {
    console.warn('[gmail.fetchNewMessages] failed to parse history response:', rawJson.slice(0, 200));
    return [];
  }
  console.info(
    `[gmail.fetchNewMessages] startHistoryId=${startHistoryId} (push=${historyId}) → ${history.history?.length ?? 0} history record(s); raw=${rawJson.slice(0, 300)}`,
  );

  const messageIds: string[] = [];
  for (const h of history.history ?? []) {
    for (const added of h.messagesAdded ?? []) {
      if (added.message?.id) messageIds.push(added.message.id);
    }
  }

  // Fetch full messages
  const messages = [];
  for (const msgId of messageIds) {
    const msgRes = await fetch(`${GMAIL_API}/messages/${msgId}?format=full`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (msgRes.ok) messages.push(await msgRes.json());
  }
  return messages;
}

// ============================================================
// Parse Gmail message into NormalizedMessage
// ============================================================

function getHeader(
  headers: { name?: string; value?: string }[] | undefined,
  name: string,
): string {
  return headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? '';
}

interface GmailPayload {
  mimeType?: string;
  body?: { data?: string };
  headers?: { name?: string; value?: string }[];
  parts?: GmailPayload[];
}

function extractTextBody(payload: GmailPayload): string {
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64url').toString('utf8');
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      const text = extractTextBody(part);
      if (text) return text;
    }
  }
  return '';
}

function extractHtmlBody(payload: GmailPayload): string {
  if (payload.mimeType === 'text/html' && payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64url').toString('utf8');
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      const html = extractHtmlBody(part);
      if (html) return html;
    }
  }
  return '';
}

export function parseGmailMessage(
  gmailMsg: { id?: string; threadId?: string; payload?: GmailPayload },
  companyId: string,
): NormalizedMessage | null {
  const headers = gmailMsg.payload?.headers;
  const from = getHeader(headers, 'From');
  const subject = getHeader(headers, 'Subject');
  const messageId = getHeader(headers, 'Message-ID');
  const date = getHeader(headers, 'Date');

  const emailMatch = from.match(/<(.+?)>/) ?? [null, from];
  const senderEmail = emailMatch[1] ?? from;
  const senderName = from.replace(/<.*?>/, '').trim() || senderEmail;
  const textBody = gmailMsg.payload ? extractTextBody(gmailMsg.payload) : '';
  const htmlBody = gmailMsg.payload ? extractHtmlBody(gmailMsg.payload) : '';

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
    html_body: htmlBody || null,
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
  message: { data: string; messageId: string; publishTime: string };
  subscription: string;
}

const emailInbound: InboundAdapter = {
  channel: 'email',

  async verifyWebhook(): Promise<boolean> {
    return true; // Pub/Sub verification handled at transport level
  },

  parseWebhook(body: unknown, companyId: string): NormalizedMessage[] {
    const data = body as GmailPubSubPayload;
    if (!data.message?.data) return [];

    const decoded = JSON.parse(
      Buffer.from(data.message.data, 'base64').toString('utf8'),
    ) as { emailAddress: string; historyId: string };

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
// Outbound Adapter (send via Gmail REST API)
// ============================================================

/**
 * Send a single email via the Gmail REST API using a stored refresh
 * token. Called by smtp.ts when the account's credentials carry
 * provider='gmail' + refresh_token (OAuth-connected mailbox) instead
 * of an SMTP password.
 */
export async function gmailApiSend(
  creds: DecryptedCredentials,
  msg: OutboundMessage,
  recipientEmail: string,
): Promise<SendResult> {
  const refreshToken = creds.refresh_token as string;
  const senderEmail = creds.email_address as string;
  const token = await getAccessToken(refreshToken);

  const subject = (msg.metadata?.subject as string) ?? 'Re: Your message';
  const raw = [
    `From: ${senderEmail}`,
    `To: ${recipientEmail}`,
    `Subject: ${subject}`,
    `Content-Type: text/plain; charset=utf-8`,
    '',
    msg.text,
  ].join('\r\n');

  const encodedMessage = Buffer.from(raw).toString('base64url');
  const body: { raw: string; threadId?: string } = { raw: encodedMessage };
  if (msg.metadata?.gmail_thread_id) {
    body.threadId = msg.metadata.gmail_thread_id as string;
  }

  const res = await fetch(`${GMAIL_API}/messages/send`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    return {
      channel_message_id: '',
      status: 'failed',
      error_message: `Gmail send failed: ${res.status} ${JSON.stringify(err)}`,
    };
  }

  const result = (await res.json()) as { id?: string };
  return { channel_message_id: result.id ?? '', status: 'sent' };
}

const emailOutbound: OutboundAdapter = {
  channel: 'email',
  send: gmailApiSend,
};

// NOTE: Outbound email is now handled by the SMTP adapter at
// src/lib/adapters/email/smtp.ts, which self-registers emailInbound
// together with its SMTP-based send implementation. We no longer
// register Gmail OAuth send here because the stored channel_accounts
// credentials are SMTP/IMAP-shaped (email_address + password), not
// OAuth refresh tokens. The inbound export below is still used by
// smtp.ts (so it can register the inbound half) and by the Gmail
// Pub/Sub webhook route. The OAuth helpers (exchangeGmailCode,
// registerGmailWatch, fetchNewMessages, parseGmailMessage) remain
// exported and are still used by the gmail-callback and renew
// cron routes.

export { emailInbound, emailOutbound };
