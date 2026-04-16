import { NextResponse, type NextRequest } from 'next/server';
import { getChannelAccount, insertWebhookLog, upsertContact, upsertConversation, insertMessage, incrementConversationCounts } from '@/lib/db/queries';
import { decryptCredentials } from '@/lib/credentials';
import { fetchNewMessages, parseGmailMessage } from '@/lib/adapters/email/gmail';

/**
 * POST: Email push notification webhook.
 * Google Pub/Sub sends a push notification when new email arrives.
 * Unlike other channels, we process email synchronously because we need
 * to fetch the actual email content via Gmail API (the push only contains historyId).
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ companyId: string }> },
) {
  const { companyId } = await params;

  const body = await req.json();
  insertWebhookLog('email', companyId, body).catch(() => {});

  // Decode Pub/Sub push notification
  const messageData = body.message?.data;
  if (!messageData) {
    return new Response('OK', { status: 200 });
  }

  const decoded = JSON.parse(
    Buffer.from(messageData, 'base64').toString('utf8'),
  ) as { emailAddress: string; historyId: string };

  // Find the email account for this company
  const account = await getChannelAccount(companyId, 'email');
  if (!account) {
    return new Response('OK', { status: 200 });
  }

  const creds = decryptCredentials(account.credentials);
  if (creds.provider !== 'gmail') {
    return new Response('OK', { status: 200 });
  }

  try {
    // Fetch actual email messages since the historyId
    const gmailMessages = await fetchNewMessages(
      creds.refresh_token as string,
      decoded.historyId,
    );

    let processed = 0;

    for (const gmailMsg of gmailMessages) {
      const normalized = parseGmailMessage(gmailMsg, companyId);
      if (!normalized || normalized.sender_role === 'system') continue;

      // Skip emails sent by the company itself
      if (normalized.channel_sender_id === creds.email_address) continue;

      const contactId = await upsertContact(
        companyId,
        'email',
        normalized.channel_sender_id,
        normalized.sender_name,
        null,
      );

      const conversationId = await upsertConversation(
        companyId,
        'email',
        contactId,
        account.id,
        normalized.channel_thread_id,
        normalized.text_body?.slice(0, 200) ?? null,
        normalized.subject ?? null,
      );

      const { isDuplicate } = await insertMessage(conversationId, normalized);
      if (!isDuplicate) {
        processed++;
        await incrementConversationCounts(conversationId);
      }
    }

    return NextResponse.json({ processed });
  } catch (err) {
    console.error('Email webhook processing failed:', err);
    return new Response('OK', { status: 200 }); // Still ack to prevent retries
  }
}
