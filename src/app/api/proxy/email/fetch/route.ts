import { NextResponse, type NextRequest } from 'next/server';
import {
  authenticateRequest,
  getSupportWorkspaceId,
  getUserCompanyIds,
} from '@/lib/auth/middleware';
import { getServiceClient } from '@/lib/db/supabase';
import { decryptCredentials } from '@/lib/credentials';
import { fetchUnreadEmails } from '@/lib/adapters/email/imap-fetch';
import { upsertContact, upsertConversation, insertMessage, bumpConversation } from '@/lib/db/queries';
import { forwardInboundToSupport } from '@/lib/forwarders/support';

type EmailCreds = {
  email_address: string;
  password: string;
  imap_host: string;
  imap_port: string;
  provider: string;
  /** Present on OAuth-connected mailboxes; mutually-exclusive with the
   *  IMAP fields above. We branch on this before attempting IMAP. */
  refresh_token?: string;
};

type FetchResult = {
  company_id: string;
  email: string;
  fetched: number;
  stored: number;
  duplicates: number;
  error?: string;
  /** Non-error reason this account wasn't polled. Used for OAuth mailboxes
   *  that receive mail via Gmail Pub/Sub push and have no IMAP creds —
   *  the frontend treats `skipped` as success-with-message, not error. */
  skipped?: string;
};

// Pulls unread mail for a single connected account and inserts into the
// messages table with idempotency. Shared between the single-company and
// {all:true} system-cron paths below.
async function fetchOneAccount(
  account: {
    id: string;
    company_id: string;
    credentials: string;
    delivery_target?: string | null;
  },
  supabase: ReturnType<typeof getServiceClient>,
): Promise<FetchResult> {
  const creds = decryptCredentials(account.credentials) as unknown as EmailCreds;
  const base = {
    company_id: account.company_id,
    email: creds.email_address || '?',
    fetched: 0,
    stored: 0,
    duplicates: 0,
  };

  // OAuth-connected mailboxes (provider='gmail' + refresh_token) receive
  // mail via Pub/Sub push and have no IMAP creds by design. Reporting
  // them as "Incomplete credentials" confuses operators. Surface them
  // as `skipped` so the frontend can show a friendly message instead.
  if (creds.provider === 'gmail' && typeof creds.refresh_token === 'string' && creds.refresh_token) {
    return { ...base, skipped: 'OAuth mailbox — auto-syncs via Gmail push' };
  }

  if (!creds.email_address || !creds.password || !creds.imap_host) {
    return { ...base, error: 'Incomplete credentials' };
  }

  const emails = await fetchUnreadEmails(creds, account.company_id);
  let stored = 0;
  let duplicates = 0;

  for (const msg of emails) {
    const contactId = await upsertContact(
      account.company_id, 'email', msg.channel_sender_id, msg.sender_name, null,
    );
    const preview = msg.text_body?.slice(0, 200) ?? null;
    const { id: conversationId, isNew } = await upsertConversation(
      account.company_id, 'email', contactId, account.id,
      msg.channel_thread_id, preview, msg.subject ?? null,
    );
    const { isDuplicate } = await insertMessage(conversationId, msg);
    if (isDuplicate) duplicates++;
    else {
      stored++;
      if (!isNew) await bumpConversation(conversationId, preview, 'inbound');
      forwardInboundToSupport({
        account: { ...account, channel: 'email' },
        msg,
        conversationId,
      });
    }
  }

  if (stored > 0) {
    await supabase
      .from('channel_accounts')
      .update({ last_webhook_at: new Date().toISOString() })
      .eq('id', account.id);
  }

  return { ...base, fetched: emails.length, stored, duplicates };
}

/**
 * POST /api/proxy/email/fetch
 *
 * Three auth paths:
 *   1. User JWT              — manual refresh from the app; body: { company_id }
 *   2. x-cron-secret header  — legacy Vercel-Cron style; body: { company_id }
 *   3. Authorization: Bearer <CRON_SHARED_SECRET> — Supabase pg_cron.
 *      With body { all: true } iterates every active email account; with
 *      { company_id } behaves like path 2.
 */
export async function POST(req: NextRequest) {
  const body: { company_id?: string; all?: boolean } = await req.json().catch(() => ({}));

  const authHeader = req.headers.get('authorization');
  const xCronSecret = req.headers.get('x-cron-secret');
  const sharedSecret = process.env.CRON_SHARED_SECRET;

  const isSystemCron =
    !!sharedSecret && authHeader === `Bearer ${sharedSecret}`;
  const isLegacyCron = xCronSecret === process.env.CRON_SECRET;

  const supabase = getServiceClient();

  // ── System-cron batch mode: iterate every active email account ────────
  if (isSystemCron && body.all === true) {
    const { data: accounts, error } = await supabase
      .from('channel_accounts')
      .select('id, company_id, credentials, delivery_target')
      .eq('channel', 'email')
      .eq('is_active', true);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    if (!accounts?.length) {
      return NextResponse.json({ accounts: 0, results: [] });
    }

    const results: FetchResult[] = [];
    for (const account of accounts) {
      try {
        results.push(await fetchOneAccount(account, supabase));
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        results.push({
          company_id: account.company_id, email: '?',
          fetched: 0, stored: 0, duplicates: 0, error: message,
        });
      }
    }

    const totalStored = results.reduce((n, r) => n + r.stored, 0);
    return NextResponse.json({ accounts: accounts.length, stored: totalStored, results });
  }

  // ── Single-company path (user, legacy cron, or system-cron w/out all) ─
  let companyId: string | undefined;

  if (isSystemCron || isLegacyCron) {
    companyId = body.company_id;
  } else {
    const auth = await authenticateRequest(req);
    if ('error' in auth) return auth.error;

    companyId = body.company_id;
    if (!companyId) {
      return NextResponse.json({ error: 'company_id required' }, { status: 400 });
    }

    // Allow either: BPO user_companies match, or Support workspace claim match.
    const userCompanies = await getUserCompanyIds(auth.user.id, auth.user.accessToken);
    const supportWorkspace = getSupportWorkspaceId(auth.user);
    const ok = userCompanies.includes(companyId) || supportWorkspace === companyId;
    if (!ok) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
  }

  if (!companyId) {
    return NextResponse.json({ error: 'company_id required' }, { status: 400 });
  }

  const { data: account } = await supabase
    .from('channel_accounts')
    .select('id, company_id, credentials')
    .eq('company_id', companyId)
    .eq('channel', 'email')
    .eq('is_active', true)
    .single();

  if (!account) {
    return NextResponse.json({ error: 'No active email account for this company' }, { status: 404 });
  }

  try {
    const result = await fetchOneAccount(account, supabase);
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('IMAP fetch failed:', message);

    if (message.includes('Invalid credentials') || message.includes('AUTHENTICATIONFAILED')) {
      return NextResponse.json(
        { error: 'Invalid email credentials. Check your app password.' },
        { status: 401 },
      );
    }
    if (message.includes('ECONNREFUSED') || message.includes('ETIMEDOUT')) {
      return NextResponse.json(
        { error: 'Cannot connect to IMAP server. Check host and port.' },
        { status: 502 },
      );
    }

    return NextResponse.json({ error: `IMAP fetch failed: ${message}` }, { status: 500 });
  }
}
