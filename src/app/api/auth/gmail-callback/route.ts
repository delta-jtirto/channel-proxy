import { NextResponse, type NextRequest } from 'next/server';
import { exchangeGmailCode, registerGmailWatch } from '@/lib/adapters/email/gmail';
import { encryptCredentials } from '@/lib/credentials';
import { getServiceClient } from '@/lib/db/supabase';

/**
 * GET /api/auth/gmail-callback?code=...&state=...
 * OAuth callback from Google after user grants Gmail access.
 *
 * State contains: { companyId, userId, deliveryTarget, returnUrl }
 *   - deliveryTarget: 'bpo' | 'support' — written onto channel_accounts so
 *     inbound messages route correctly. Defaults to 'bpo' for backwards
 *     compatibility with any in-flight OAuth handshakes from before this
 *     change shipped.
 *   - returnUrl: where to redirect the popup once the channel_accounts
 *     row is upserted. Falls back to AI_BPO_URL/settings for legacy BPO,
 *     then to '/' if no URL is known.
 */
export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get('code');
  const stateParam = req.nextUrl.searchParams.get('state');

  if (!code || !stateParam) {
    return NextResponse.json({ error: 'Missing code or state' }, { status: 400 });
  }

  let state: {
    companyId: string;
    userId: string;
    deliveryTarget?: 'bpo' | 'support';
    returnUrl?: string;
  };
  try {
    state = JSON.parse(Buffer.from(stateParam, 'base64url').toString('utf8'));
  } catch {
    return NextResponse.json({ error: 'Invalid state' }, { status: 400 });
  }
  const deliveryTarget: 'bpo' | 'support' =
    state.deliveryTarget === 'support' ? 'support' : 'bpo';

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
        handle: tokens.email_address,
        credentials: encryptedCreds,
        delivery_target: deliveryTarget,
        is_active: true,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'company_id,channel,handle' },
    );

    // Redirect the popup to the caller's chosen return URL (set by
    // Support's ChannelsSection, or BPO's panel) so the parent window's
    // `popup.closed` poll can detect completion. Fall back to the BPO
    // settings page for legacy callers that don't set returnUrl.
    const redirectUrl =
      state.returnUrl ??
      (process.env.AI_BPO_URL
        ? `${process.env.AI_BPO_URL}/settings?email_connected=true`
        : '/');

    return NextResponse.redirect(redirectUrl);
  } catch (err) {
    console.error('Gmail OAuth callback failed:', err);
    return NextResponse.json(
      { error: 'Gmail connection failed' },
      { status: 500 },
    );
  }
}
