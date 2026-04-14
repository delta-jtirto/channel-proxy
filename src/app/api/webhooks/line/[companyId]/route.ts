import { type NextRequest } from 'next/server';
import '@/lib/adapters/line';
import { getChannelAccount, insertWebhookLog } from '@/lib/db/queries';
import { decryptCredentials } from '@/lib/credentials';
import { enqueueWebhook } from '@/lib/queue';
import { registry } from '@/lib/adapters/registry';

/** POST: LINE webhook — ack immediately, enqueue for processing. */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ companyId: string }> },
) {
  const { companyId } = await params;
  const account = await getChannelAccount(companyId, 'line');
  if (!account) return new Response('Not Found', { status: 404 });

  const creds = decryptCredentials(account.credentials);
  const adapter = registry.getInbound('line')!;

  const isValid = await adapter.verifyWebhook(req, creds.channel_secret as string);
  if (!isValid) return new Response('Unauthorized', { status: 401 });

  const body = await req.json();
  insertWebhookLog('line', companyId, body).catch(() => {});

  enqueueWebhook({
    channel: 'line',
    companyId,
    payload: body,
    receivedAt: new Date().toISOString(),
  }).catch((err) => console.error('Failed to enqueue LINE webhook:', err));

  return new Response('OK', { status: 200 });
}
