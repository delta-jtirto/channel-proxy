import { NextResponse } from 'next/server';
import { getServiceClient } from '@/lib/db/supabase';
import { decryptCredentials } from '@/lib/credentials';
import { registerGmailWatch } from '@/lib/adapters/email/gmail';

/**
 * GET /api/cron/renew-gmail-watches
 * Renew Gmail watch() subscriptions that expire every 7 days.
 * Runs daily at 3:17 AM via Vercel Cron.
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

  if (error) {
    console.error('Failed to fetch email accounts:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  let renewed = 0;
  let failed = 0;

  for (const account of accounts ?? []) {
    try {
      const creds = decryptCredentials(account.credentials);

      // Only renew Gmail accounts (not Microsoft or IMAP)
      if (creds.provider !== 'gmail') continue;

      await registerGmailWatch(creds.refresh_token as string);
      renewed++;
    } catch (err) {
      console.error(`Failed to renew watch for account ${account.id}:`, err);
      failed++;
    }
  }

  return NextResponse.json({ renewed, failed, total: accounts?.length ?? 0 });
}
