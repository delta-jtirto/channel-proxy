import { NextResponse } from 'next/server';
import { getServiceClient } from '@/lib/db/supabase';
import { decryptCredentials } from '@/lib/credentials';
import { fetchUnreadEmails } from '@/lib/adapters/email/imap-fetch';
import { upsertContact, upsertConversation, insertMessage } from '@/lib/db/queries';

/**
 * GET /api/cron/fetch-emails
 * Poll all active email accounts for new unread messages.
 * Runs every 2 minutes via Vercel CRON.
 */
export async function GET(req: Request) {
  const authHeader = req.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  const supabase = getServiceClient();

  // Get all active email accounts
  const { data: accounts, error } = await supabase
    .from('channel_accounts')
    .select('id, company_id, credentials')
    .eq('channel', 'email')
    .eq('is_active', true);

  if (error || !accounts?.length) {
    return NextResponse.json({ message: 'No active email accounts', accounts: 0 });
  }

  const results: { companyId: string; email: string; fetched: number; stored: number; error?: string }[] = [];

  for (const account of accounts) {
    try {
      const creds = decryptCredentials(account.credentials) as {
        email_address: string;
        password: string;
        imap_host: string;
        imap_port: string;
        provider: string;
      };

      if (!creds.imap_host || !creds.password) {
        results.push({ companyId: account.company_id, email: creds.email_address || '?', fetched: 0, stored: 0, error: 'Incomplete credentials' });
        continue;
      }

      const emails = await fetchUnreadEmails(creds, account.company_id);
      let stored = 0;

      for (const msg of emails) {
        const contactId = await upsertContact(account.company_id, 'email', msg.channel_sender_id, msg.sender_name, null);
        const conversationId = await upsertConversation(account.company_id, 'email', contactId, account.id, msg.channel_thread_id, msg.text_body?.slice(0, 200) ?? null, msg.subject ?? null);
        const { isDuplicate } = await insertMessage(conversationId, msg);
        if (!isDuplicate) stored++;
      }

      if (stored > 0) {
        await supabase.from('channel_accounts').update({ last_webhook_at: new Date().toISOString() }).eq('id', account.id);
      }

      results.push({ companyId: account.company_id, email: creds.email_address, fetched: emails.length, stored });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      results.push({ companyId: account.company_id, email: '?', fetched: 0, stored: 0, error: message });
    }
  }

  return NextResponse.json({ accounts: accounts.length, results });
}
