import { NextResponse, type NextRequest } from 'next/server';
import { authenticateRequest } from '@/lib/auth/middleware';
import { checkScope, type DeliveryTarget } from '@/lib/auth/scope';
import { getServiceClient } from '@/lib/db/supabase';
import { encryptCredentials, deltaOwnedCredentialsBlob } from '@/lib/credentials';

/**
 * A voice/video account is Delta-OWNED (uses the shared env Twilio account)
 * unless the connect request brings its own Twilio creds — both `account_sid`
 * AND `auth_token` present. Delta-owned rows store an empty encrypted blob
 * (deltaOwnedCredentialsBlob) so resolveTwilioCreds falls back to env; the
 * dialed number still lands in `handle` (extractHandle), never the secret blob.
 */
function hasByoTwilioCreds(credentials: Record<string, unknown>): boolean {
  const sid = credentials.account_sid;
  const token = credentials.auth_token;
  return (
    typeof sid === 'string' &&
    sid.trim().length > 0 &&
    typeof token === 'string' &&
    token.trim().length > 0
  );
}

/**
 * Pull a human-readable handle out of the credentials bundle so the
 * settings UI can show the actual mailbox / phone / id instead of the
 * operator-typed display_name. Always safe to persist (no secrets).
 *
 * If a channel's only identifier IS sensitive, return null and we'll
 * store nothing — the row falls back to display_name in the UI.
 */
function extractHandle(
  channel: string,
  credentials: Record<string, unknown>,
): string | null {
  const s = (k: string): string | null => {
    const v = credentials[k];
    return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
  };
  switch (channel) {
    case 'email':
      return s('email_address');
    case 'whatsapp':
    case 'wati':
      return s('phone_number_id');
    case 'instagram':
      return s('ig_user_id');
    case 'line':
      return s('channel_id');
    case 'voice':
    case 'video':
      return s('phone_number'); // Twilio E.164 number, e.g. '+16505551234'
    default:
      return null;
  }
}

/**
 * GET /api/proxy/accounts?company_id=X
 * List channel accounts for a company the user has access to.
 */
export async function GET(req: NextRequest) {
  const auth = await authenticateRequest(req);
  if ('error' in auth) return auth.error;

  const companyId = req.nextUrl.searchParams.get('company_id');
  if (!companyId) {
    return NextResponse.json({ error: 'company_id required' }, { status: 400 });
  }
  // The caller hints at scope via `delivery_target` (defaults to 'bpo').
  // Support's frontend always sends `delivery_target=support` so we know
  // to verify against the workspace claim, not user_companies.
  const dt = (req.nextUrl.searchParams.get('delivery_target') ?? 'bpo') as DeliveryTarget;
  if (dt !== 'bpo' && dt !== 'support') {
    return NextResponse.json({ error: 'Invalid delivery_target' }, { status: 400 });
  }

  const denied = await checkScope(auth.user, companyId, dt);
  if (denied) return denied;

  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from('channel_accounts')
    .select(
      'id, company_id, channel, display_name, handle, is_active, host_id, delivery_target, last_webhook_at, created_at, updated_at',
    )
    .eq('company_id', companyId)
    .eq('delivery_target', dt)
    .order('created_at');

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Attach the property binding set for each account. 0 rows = "all
  // properties" (legacy default); we return prop_ids: [] in that case.
  const accountIds = (data ?? []).map((a) => a.id);
  const propsByAccount = new Map<string, string[]>();
  if (accountIds.length > 0) {
    const { data: propRows, error: propErr } = await supabase
      .from('channel_account_properties')
      .select('account_id, prop_id')
      .in('account_id', accountIds);
    if (propErr) {
      return NextResponse.json({ error: propErr.message }, { status: 500 });
    }
    for (const row of propRows ?? []) {
      const list = propsByAccount.get(row.account_id) ?? [];
      list.push(row.prop_id);
      propsByAccount.set(row.account_id, list);
    }
  }

  const accounts = (data ?? []).map((a) => ({
    ...a,
    prop_ids: propsByAccount.get(a.id) ?? [],
  }));

  return NextResponse.json({ accounts });
}

/**
 * POST /api/proxy/accounts
 * Connect a new channel account.
 */
export async function POST(req: NextRequest) {
  const auth = await authenticateRequest(req);
  if ('error' in auth) return auth.error;

  const body = await req.json();
  const { company_id, channel, display_name, credentials, host_id } = body;
  const delivery_target: DeliveryTarget = body.delivery_target === 'support' ? 'support' : 'bpo';
  // Optional channel<->property binding set. Empty/absent = "all
  // properties" (legacy default) -- we insert no rows in that case.
  const propIds: string[] = Array.isArray(body.prop_ids)
    ? body.prop_ids.filter(
        (p: unknown): p is string => typeof p === 'string' && p.trim().length > 0,
      )
    : [];

  if (!company_id || !channel || !display_name || !credentials) {
    return NextResponse.json(
      { error: 'company_id, channel, display_name, and credentials are required' },
      { status: 400 },
    );
  }

  const denied = await checkScope(auth.user, company_id, delivery_target);
  if (denied) return denied;

  // Encrypt credentials before storing. A Delta-owned voice/video number
  // carries no BYO Twilio creds, so store an empty (encrypted) blob — the
  // credentials column is NOT NULL, and resolveTwilioCreds env-falls-back on
  // the absent account_sid/auth_token. The dialed number still lands in
  // `handle` below (extractHandle reads phone_number). Chat channels and
  // host-BYO voice rows keep their per-account encrypted creds untouched.
  const isDeltaOwnedVoice =
    (channel === 'voice' || channel === 'video') && !hasByoTwilioCreds(credentials);
  const encryptedCreds = isDeltaOwnedVoice
    ? deltaOwnedCredentialsBlob()
    : encryptCredentials(credentials);
  const handle = extractHandle(channel, credentials);

  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from('channel_accounts')
    .insert({
      company_id,
      channel,
      display_name,
      credentials: encryptedCreds,
      delivery_target,
      handle,
      ...(host_id ? { host_id } : {}),
    })
    .select('id, company_id, channel, display_name, handle, is_active, host_id, delivery_target, created_at')
    .single();

  if (error) {
    if (error.code === '23505') {
      return NextResponse.json(
        { error: `Company already has a ${channel} account` },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Persist the channel<->property binding set, if any. Each row carries
  // company_id for RLS (mirrors channel_accounts). 0 rows = all properties.
  if (propIds.length > 0) {
    const { error: propErr } = await supabase
      .from('channel_account_properties')
      .insert(
        propIds.map((prop_id) => ({ account_id: data.id, prop_id, company_id })),
      );
    if (propErr) {
      return NextResponse.json({ error: propErr.message }, { status: 500 });
    }
  }

  return NextResponse.json({ account: { ...data, prop_ids: propIds } }, { status: 201 });
}
