import nodemailer, { type Transporter } from 'nodemailer';
import type {
  OutboundAdapter,
  DecryptedCredentials,
  OutboundMessage,
  SendResult,
} from '../types';
import { registry } from '../registry';
import { emailInbound } from './gmail';

// ============================================================
// SMTP outbound adapter
// ============================================================
//
// Pairs with the IMAP inbound flow (cron/fetch-emails) which stores
// credentials in the shape:
//   { email_address, password, imap_host, imap_port, smtp_host, smtp_port, provider }
//
// Uses nodemailer to send via the stored SMTP host/port with app-password
// auth. Threads replies using RFC 5322 In-Reply-To / References headers,
// sourcing the original Message-ID from conversation.channel_thread_id
// (which imap-fetch.ts stores as the Message-ID header, wrapped in <...>).

interface SmtpCredentials {
  email_address: string;
  password: string;
  smtp_host: string;
  smtp_port: string;
  provider?: string;
}

function isSmtpCreds(creds: DecryptedCredentials): creds is DecryptedCredentials & SmtpCredentials {
  return (
    typeof creds.email_address === 'string' &&
    typeof creds.password === 'string' &&
    typeof creds.smtp_host === 'string' &&
    typeof creds.smtp_port === 'string'
  );
}

function buildTransport(creds: SmtpCredentials): Transporter {
  const port = parseInt(creds.smtp_port, 10);
  return nodemailer.createTransport({
    host: creds.smtp_host,
    port,
    // 465 = implicit TLS; 587/25 = STARTTLS
    secure: port === 465,
    requireTLS: port !== 465,
    auth: {
      user: creds.email_address,
      pass: creds.password,
    },
  });
}

const smtpOutbound: OutboundAdapter = {
  channel: 'email',

  async send(
    creds: DecryptedCredentials,
    msg: OutboundMessage,
    recipientEmail: string,
  ): Promise<SendResult> {
    if (!isSmtpCreds(creds)) {
      return {
        channel_message_id: '',
        status: 'failed',
        error_message:
          'Email credentials missing SMTP fields (smtp_host, smtp_port, email_address, password). Re-connect the email account.',
      };
    }

    if (!recipientEmail) {
      return {
        channel_message_id: '',
        status: 'failed',
        error_message: 'Missing recipient email address',
      };
    }

    const subject = (msg.metadata?.subject as string) ?? 'Re: Your message';
    const inReplyTo = msg.metadata?.in_reply_to_header as string | undefined;

    try {
      const transport = buildTransport(creds);
      const info = await transport.sendMail({
        from: creds.email_address,
        to: recipientEmail,
        subject,
        text: msg.text,
        // Threading — set only when we have a prior Message-ID to chain to.
        ...(inReplyTo ? { inReplyTo, references: inReplyTo } : {}),
        headers: {
          'X-Entity-Ref-ID': msg.conversation_id,
        },
      });

      return {
        channel_message_id: info.messageId ?? `smtp_${Date.now()}`,
        status: 'sent',
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        channel_message_id: '',
        status: 'failed',
        error_message: `SMTP send failed: ${message}`,
      };
    }
  },
};

// Register as the single binding for the 'email' channel.
// emailInbound handles Gmail Pub/Sub push notifications;
// smtpOutbound handles SMTP sends. IMAP polling is a separate cron path.
registry.register(emailInbound, smtpOutbound);

export { smtpOutbound };
