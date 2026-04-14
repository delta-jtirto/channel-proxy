import { NextResponse, type NextRequest } from 'next/server';
import { exchangeGmailCode, registerGmailWatch } from '@/lib/adapters/email/gmail';
import { encryptCredentials } from '@/lib/credentials';
import { getServiceClient } from '@/lib/db/supabase';

/**
 * GET /api/auth/gmail-callback?code=...&state=...
 * OAuth callback from Google after user grants Gmail access.
 * State contains: { companyId, userId }
 */
export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get('code');
  const stateParam = req.nextUrl.searchParams.get('state');

  if (!code || !stateParam) {
    return NextResponse.json({ error: 'Missing code or state' }, { status: 400 });
  }

  let state: { companyId: string; userId: string };
  try {
    state = JSON.parse(Buffer.from(stateParam, 'base64url').toString('utf8'));
  } catch {
    return NextResponse.json({ error: 'Invalid state' }, { status: 400 });
  }

  try {
    // Exchange code for tokens
    const tokens = await exchangeGmailCode(code);

    // Register Gmail watch for push notifications
    await registerGmailWatch(tokens.refresh_token);

    // Store encrypted credentials
    const encryptedCreds = encryptCredentials({
      provider: 'gmail',
      refresh_token: tokens.refresh_token,
      email_address: tokens.email_address,
    });

    const supabase = getServiceClient();
    await supabase.from('channel_accounts').upsert(
      {
        company_id: state.companyId,
        channel: 'email',
        display_name: tokens.email_address,
        credentials: encryptedCreds,
        is_active: true,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'company_id,channel' },
    );

    // Redirect back to the AI BPO settings page
    const redirectUrl = process.env.AI_BPO_URL
      ? `${process.env.AI_BPO_URL}/settings?email_connected=true`
      : '/';

    return NextResponse.redirect(redirectUrl);
  } catch (err) {
    console.error('Gmail OAuth callback failed:', err);
    return NextResponse.json(
      { error: 'Gmail connection failed' },
      { status: 500 },
    );
  }
}
