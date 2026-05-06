import { NextResponse, type NextRequest } from 'next/server';
import { randomBytes } from 'crypto';
import { authenticateRequest, getUserCompanyIds } from '@/lib/auth/middleware';
import { getServiceClient } from '@/lib/db/supabase';
import { encryptCredentials } from '@/lib/credentials';

// Meta Graph API version used by the rest of the proxy
const GRAPH_VERSION = 'v21.0';

interface EmbeddedSignupBody {
  company_id?: string;
  code?: string;
  phone_number_id?: string;
  waba_id?: string;
  business_id?: string;
  host_id?: string;
}

/**
 * POST /api/proxy/accounts/whatsapp/embedded-signup
 *
 * Completes Meta Embedded Signup v4: takes the auth code from the popup,
 * exchanges it for a long-lived access token, subscribes the customer's
 * WABA to this app's webhooks, and stores credentials in the same shape
 * the rest of the proxy expects.
 *
 * Prereqs (env): META_APP_ID, META_APP_SECRET. The app must already be
 * approved by Meta for whatsapp_business_management +
 * whatsapp_business_messaging.
 */
export async function POST(req: NextRequest) {
  const auth = await authenticateRequest(req);
  if ('error' in auth) return auth.error;

  const body = (await req.json().catch(() => ({}))) as EmbeddedSignupBody;
  const { company_id, code, phone_number_id, waba_id, host_id } = body;

  if (!company_id || !code || !phone_number_id || !waba_id) {
    return NextResponse.json(
      { error: 'company_id, code, phone_number_id, and waba_id are required' },
      { status: 400 },
    );
  }

  const userCompanies = await getUserCompanyIds(auth.user.id);
  if (!userCompanies.includes(company_id)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  if (!appId || !appSecret) {
    return NextResponse.json(
      { error: 'Embedded Signup not configured: META_APP_ID and META_APP_SECRET must be set' },
      { status: 503 },
    );
  }

  // 1. Exchange auth code for an access token.
  // Per Meta docs: GET /{graph-version}/oauth/access_token
  //   ?client_id=...&client_secret=...&code=...
  // Returns { access_token, token_type, expires_in } — for ES the token is
  // long-lived (no expiry) when generated via the System User flow.
  let accessToken: string;
  try {
    const tokenUrl = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token`);
    tokenUrl.searchParams.set('client_id', appId);
    tokenUrl.searchParams.set('client_secret', appSecret);
    tokenUrl.searchParams.set('code', code);
    const tokenRes = await fetch(tokenUrl);
    const tokenJson = (await tokenRes.json()) as { access_token?: string; error?: { message?: string } };
    if (!tokenRes.ok || !tokenJson.access_token) {
      return NextResponse.json(
        { error: tokenJson.error?.message || 'Token exchange failed' },
        { status: 502 },
      );
    }
    accessToken = tokenJson.access_token;
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Token exchange network error' },
      { status: 502 },
    );
  }

  // 2. Subscribe this app to the WABA's webhooks. Without this Meta will not
  // deliver inbound messages even though the user authorized the app.
  // POST /{waba-id}/subscribed_apps with the customer access token.
  try {
    const subUrl = `https://graph.facebook.com/${GRAPH_VERSION}/${waba_id}/subscribed_apps`;
    const subRes = await fetch(subUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!subRes.ok) {
      const errJson = (await subRes.json().catch(() => ({}))) as { error?: { message?: string } };
      return NextResponse.json(
        { error: `WABA subscription failed: ${errJson.error?.message || subRes.statusText}` },
        { status: 502 },
      );
    }
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'WABA subscription network error' },
      { status: 502 },
    );
  }

  // 3. Persist credentials in the same shape the manual flow uses, so the
  // existing webhook + send paths work without changes.
  const verifyToken = process.env.META_VERIFY_TOKEN_DEFAULT || randomBytes(16).toString('hex');
  const credentials = {
    phone_number_id,
    waba_id,
    access_token: accessToken,
    app_secret: appSecret,
    verify_token: verifyToken,
    onboarded_via: 'embedded_signup_v4' as const,
  };
  const encrypted = encryptCredentials(credentials);

  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from('channel_accounts')
    .insert({
      company_id,
      channel: 'whatsapp',
      display_name: phone_number_id,
      credentials: encrypted,
      ...(host_id ? { host_id } : {}),
    })
    .select('id, company_id, channel, display_name, is_active, host_id, created_at')
    .single();

  if (error) {
    if (error.code === '23505') {
      return NextResponse.json(
        { error: 'Company already has a WhatsApp account' },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ account: data }, { status: 201 });
}
