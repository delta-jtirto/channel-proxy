import { ImapFlow } from 'imapflow';
import type { NormalizedMessage } from '../types';

interface ImapCredentials {
  email_address: string;
  password: string;
  imap_host: string;
  imap_port: string;
  provider: string;
}

interface FetchedEmail {
  uid: number;
  messageId: string;
  from: string;
  fromName: string;
  to: string;
  subject: string;
  textBody: string;
  date: string;
  inReplyTo?: string;
  references?: string;
}

/**
 * Connect to an IMAP server and fetch unread emails from the inbox.
 * Returns normalized messages ready for storage.
 */
export async function fetchUnreadEmails(
  creds: ImapCredentials,
  companyId: string,
  maxMessages: number = 20,
): Promise<NormalizedMessage[]> {
  const client = new ImapFlow({
    host: creds.imap_host,
    port: parseInt(creds.imap_port || '993', 10),
    secure: true,
    auth: {
      user: creds.email_address,
      pass: creds.password,
    },
    logger: false,
  });

  const messages: NormalizedMessage[] = [];

  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');

    try {
      // Fetch unseen messages
      const uids: number[] = [];
      // Search for unseen messages
      for await (const msg of client.fetch(
        { seen: false },
        {
          uid: true,
          envelope: true,
          bodyStructure: true,
          source: true,
        },
        { uid: true },
      )) {
        if (uids.length >= maxMessages) break;

        const envelope = msg.envelope;
        if (!envelope) continue;

        const fromAddr = envelope.from?.[0];
        const senderEmail = fromAddr?.address || '';
        const senderName = fromAddr?.name || senderEmail;
        const subject = envelope.subject || '(no subject)';
        const messageId = envelope.messageId || `imap_${msg.uid}`;
        const date = envelope.date ? new Date(envelope.date).toISOString() : new Date().toISOString();
        const inReplyTo = envelope.inReplyTo || undefined;

        // Extract plain text body from source
        let textBody = '';
        if (msg.source) {
          const raw = msg.source.toString('utf-8');
          textBody = extractPlainText(raw);
        }

        // Skip if no meaningful content
        if (!senderEmail || (!textBody && !subject)) continue;

        // Skip emails FROM the connected address (sent by us)
        if (senderEmail.toLowerCase() === creds.email_address.toLowerCase()) continue;

        // Thread ID: use In-Reply-To or References to group, fallback to messageId
        const threadId = inReplyTo || messageId;

        messages.push({
          channel: 'email',
          direction: 'inbound',
          company_id: companyId,
          channel_thread_id: threadId,
          channel_sender_id: senderEmail,
          sender_name: senderName,
          sender_role: 'contact',
          content_type: 'text',
          text_body: textBody || subject,
          subject,
          attachments: [],
          metadata: {
            provider: creds.provider,
            imap_uid: msg.uid,
            message_id_header: messageId,
            in_reply_to: inReplyTo,
          },
          channel_message_id: messageId,
          channel_timestamp: date,
          idempotency_key: `email_imap_${messageId}`,
        });

        uids.push(msg.uid);
      }

      // Mark fetched messages as seen
      if (uids.length > 0) {
        await client.messageFlagsAdd(
          { uid: uids.join(',') },
          ['\\Seen'],
          { uid: true },
        );
      }
    } finally {
      lock.release();
    }

    await client.logout();
  } catch (err) {
    // Ensure we disconnect on error
    try { await client.logout(); } catch {}
    throw err;
  }

  return messages;
}

/**
 * Simple plain text extraction from raw email source.
 * Looks for text/plain content, falls back to stripping HTML tags.
 */
function extractPlainText(raw: string): string {
  // Try to find text/plain part in a multipart email
  const boundaryMatch = raw.match(/boundary="?([^"\r\n]+)"?/i);
  if (boundaryMatch) {
    const boundary = boundaryMatch[1];
    const parts = raw.split(`--${boundary}`);
    for (const part of parts) {
      if (part.toLowerCase().includes('content-type: text/plain')) {
        // Extract body after the double newline
        const bodyStart = part.indexOf('\r\n\r\n');
        if (bodyStart !== -1) {
          let body = part.substring(bodyStart + 4).trim();
          // Handle base64 encoding
          if (part.toLowerCase().includes('content-transfer-encoding: base64')) {
            try { body = Buffer.from(body.replace(/\s/g, ''), 'base64').toString('utf-8'); } catch {}
          }
          // Handle quoted-printable
          if (part.toLowerCase().includes('content-transfer-encoding: quoted-printable')) {
            body = body.replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
          }
          return body.trim();
        }
      }
    }
  }

  // Single-part email: extract body after headers
  const bodyStart = raw.indexOf('\r\n\r\n');
  if (bodyStart !== -1) {
    let body = raw.substring(bodyStart + 4);
    // Strip HTML if it looks like HTML
    if (body.includes('<html') || body.includes('<body')) {
      body = body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    }
    return body.substring(0, 2000); // Limit length
  }

  return '';
}
