import { Client } from '@upstash/qstash';

let _client: Client | null = null;

function getClient(): Client {
  if (!_client) {
    const token = process.env.QSTASH_TOKEN;
    if (!token) {
      throw new Error('Missing QSTASH_TOKEN environment variable');
    }
    _client = new Client({ token });
  }
  return _client;
}

export interface WebhookPayload {
  channel: string;
  companyId: string;
  payload: unknown;
  receivedAt: string; // ISO timestamp
}

/**
 * Enqueue a webhook payload for background processing via QStash.
 * QStash will POST the payload to the process-webhook worker endpoint.
 */
export async function enqueueWebhook(data: WebhookPayload): Promise<void> {
  const client = getClient();
  const workerUrl = process.env.QSTASH_WORKER_URL
    ?? `${process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000'}/api/workers/process-webhook`;

  await client.publishJSON({
    url: workerUrl,
    body: data,
    retries: 3,
  });
}

/**
 * Verify a QStash signature on an incoming worker request.
 * Returns the parsed body if valid, throws if invalid.
 */
export async function verifyQStashSignature(req: Request): Promise<WebhookPayload> {
  const { Receiver } = await import('@upstash/qstash');
  const signingKey = process.env.QSTASH_CURRENT_SIGNING_KEY;
  const nextSigningKey = process.env.QSTASH_NEXT_SIGNING_KEY;

  if (!signingKey || !nextSigningKey) {
    throw new Error('Missing QSTASH signing keys');
  }

  const receiver = new Receiver({
    currentSigningKey: signingKey,
    nextSigningKey: nextSigningKey,
  });

  const body = await req.text();
  const signature = req.headers.get('upstash-signature') ?? '';

  const isValid = await receiver.verify({
    signature,
    body,
  });

  if (!isValid) {
    throw new Error('Invalid QStash signature');
  }

  return JSON.parse(body) as WebhookPayload;
}
