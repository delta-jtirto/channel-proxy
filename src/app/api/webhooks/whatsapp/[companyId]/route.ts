import { NextResponse, type NextRequest } from 'next/server';
import { whatsappInbound } from '@/lib/adapters/whatsapp';
import { getChannelAccount, insertWebhookLog } from '@/lib/db/queries';
import { decryptCredentials } from '@/lib/credentials';
import { enqueueWebhook } from '@/lib/queue';

/**
 * GET: Meta webhook verification challenge.
 * Meta sends this during webhook registration to verify ownership.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ companyId: string }> },
) {
  const { companyId } = await params;

  // Look up the account to get the verify token
  const account = await getChannelAccount(companyId, 'whatsapp');
  if (!account) {
    return new Response('Not Found', { status: 404 });
  }

  const creds = decryptCredentials(account.credentials);
  const verifyToken = creds.verify_token as string;

  return whatsappInbound.handleChallenge!(req, verifyToken);
}

/**
 * POST: Receive WhatsApp webhook.
 * Ack immediately (200 OK), then enqueue for background processing.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ companyId: string }> },
) {
  const { companyId } = await params;

  // Look up account for signature verification
  const account = await getChannelAccount(companyId, 'whatsapp');
  if (!account) {
    return new Response('Not Found', { status: 404 });
  }

  const creds = decryptCredentials(account.credentials);
  const appSecret = creds.app_secret as string;

  // Verify webhook signature
  const isValid = await whatsappInbound.verifyWebhook(req, appSecret);
  if (!isValid) {
    return new Response('Unauthorized', { status: 401 });
  }

  // Parse body
  const body = await req.json();

  // Log webhook (async, don't block response)
  insertWebhookLog('whatsapp', companyId, body).catch(() => {});

  // Enqueue for background processing (async, don't block response)
  enqueueWebhook({
    channel: 'whatsapp',
    companyId,
    payload: body,
    receivedAt: new Date().toISOString(),
  }).catch((err) => {
    console.error('Failed to enqueue WhatsApp webhook:', err);
  });

  // Return 200 immediately — Meta requires fast response
  return new Response('OK', { status: 200 });
}
