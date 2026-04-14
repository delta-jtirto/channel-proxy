import { type NextRequest } from 'next/server';
import { instagramInbound } from '@/lib/adapters/instagram';
import { getChannelAccount, insertWebhookLog } from '@/lib/db/queries';
import { decryptCredentials } from '@/lib/credentials';
import { enqueueWebhook } from '@/lib/queue';

/** GET: Meta webhook verification challenge (same as WhatsApp). */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ companyId: string }> },
) {
  const { companyId } = await params;
  const account = await getChannelAccount(companyId, 'instagram');
  if (!account) return new Response('Not Found', { status: 404 });

  const creds = decryptCredentials(account.credentials);
  return instagramInbound.handleChallenge!(req, creds.verify_token as string);
}

/** POST: Instagram webhook — ack immediately, enqueue for processing. */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ companyId: string }> },
) {
  const { companyId } = await params;
  const account = await getChannelAccount(companyId, 'instagram');
  if (!account) return new Response('Not Found', { status: 404 });

  const creds = decryptCredentials(account.credentials);
  const isValid = await instagramInbound.verifyWebhook(req, creds.app_secret as string);
  if (!isValid) return new Response('Unauthorized', { status: 401 });

  const body = await req.json();
  insertWebhookLog('instagram', companyId, body).catch(() => {});

  enqueueWebhook({
    channel: 'instagram',
    companyId,
    payload: body,
    receivedAt: new Date().toISOString(),
  }).catch((err) => console.error('Failed to enqueue Instagram webhook:', err));

  return new Response('OK', { status: 200 });
}
