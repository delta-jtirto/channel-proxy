import { NextResponse, type NextRequest } from 'next/server';
import { authenticateRequest, getUserCompanyIds } from '@/lib/auth/middleware';
import { getServiceClient } from '@/lib/db/supabase';
import { decryptCredentials } from '@/lib/credentials';
import { fetchUnreadEmails } from '@/lib/adapters/email/imap-fetch';
import { upsertContact, upsertConversation, insertMessage, incrementConversationCounts } from '@/lib/db/queries';

/**
 * POST /api/proxy/email/fetch
 * Manually trigger email fetch for a company's email account.
 * Connects to IMAP, fetches unread emails, stores in Supabase.
 *
 * Body: { company_id }
 * Also callable by CRON (with CRON_SECRET auth).
 */
export async function POST(req: NextRequest) {
  // Allow both user auth and CRON secret auth
  const cronSecret = req.headers.get('x-cron-secret');
  let companyId: string;

  if (cronSecret === process.env.CRON_SECRET) {
    // CRON call — company_id from body
    const body = await req.json();
    companyId = body.company_id;
  } else {
    // User call — verify auth
    const auth = await authenticateRequest(req);
    if ('error' in auth) return auth.error;

    const body = await req.json();
    companyId = body.company_id;

    if (!companyId) {
      return NextResponse.json({ error: 'company_id required' }, { status: 400 });
    }

    const userCompanies = await getUserCompanyIds(auth.user.id);
    if (!userCompanies.includes(companyId)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
  }

  const supabase = getServiceClient();

  // Get the email channel account
  const { data: account } = await supabase
    .from('channel_accounts')
    .select('id, credentials')
    .eq('company_id', companyId)
    .eq('channel', 'email')
    .eq('is_active', true)
    .single();

  if (!account) {
    return NextResponse.json({ error: 'No active email account for this company' }, { status: 404 });
  }

  const creds = decryptCredentials(account.credentials) as {
    email_address: string;
    password: string;
    imap_host: string;
    imap_port: string;
    provider: string;
  };

  if (!creds.email_address || !creds.password || !creds.imap_host) {
    return NextResponse.json({ error: 'Incomplete email credentials' }, { status: 400 });
  }

  try {
    // Fetch unread emails via IMAP
    const emails = await fetchUnreadEmails(creds, companyId);

    let stored = 0;
    let duplicates = 0;

    for (const msg of emails) {
      // Upsert contact
      const contactId = await upsertContact(
        companyId,
        'email',
        msg.channel_sender_id,
        msg.sender_name,
        null,
      );

      // Upsert conversation (threaded by email thread ID)
      const conversationId = await upsertConversation(
        companyId,
        'email',
        contactId,
        account.id,
        msg.channel_thread_id,
        msg.text_body?.slice(0, 200) ?? null,
        msg.subject ?? null,
      );

      // Insert message (idempotent)
      const { isDuplicate } = await insertMessage(conversationId, msg);
      if (isDuplicate) {
        duplicates++;
      } else {
        stored++;
        // Increment unread/message counts only for genuinely new messages
        // so the frontend poll detects the change and triggers auto-reply
        await incrementConversationCounts(conversationId);
      }
    }

    // Update last_webhook_at to mark as verified
    if (stored > 0) {
      await supabase
        .from('channel_accounts')
        .update({ last_webhook_at: new Date().toISOString() })
        .eq('id', account.id);
    }

    return NextResponse.json({
      fetched: emails.length,
      stored,
      duplicates,
      email: creds.email_address,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('IMAP fetch failed:', message);

    // Return specific error for common IMAP issues
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
