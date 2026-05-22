import { NextResponse, type NextRequest } from 'next/server';
import {
  authenticateRequest,
  getSupportWorkspaceId,
  getUserCompanyIds,
  type AuthUser,
} from '@/lib/auth/middleware';
import { getServiceClient } from '@/lib/db/supabase';
import { encryptCredentials } from '@/lib/credentials';

type DeliveryTarget = 'bpo' | 'support';

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
    default:
      return null;
  }
}

/**
 * Common scope check. An authenticated user may operate on a
 * `company_id` if either:
 *   - their `user_companies` row links them to it (BPO path), or
 *   - their JWT carries `app_metadata.workspace_id` equal to it AND
 *     `delivery_target === 'support'` (Support path).
 *
 * Returns null on success, an error NextResponse on rejection.
 */
async function checkScope(
  user: AuthUser,
  companyId: string,
  deliveryTarget: DeliveryTarget,
): Promise<NextResponse | null> {
  if (deliveryTarget === 'support') {
    const ws = getSupportWorkspaceId(user);
    if (!ws || ws !== companyId) {
      return NextResponse.json(
        { error: 'Forbidden — JWT workspace_id does not match the requested tenant' },
        { status: 403 },
      );
    }
    return null;
  }
  const companies = await getUserCompanyIds(user.id, user.accessToken);
  if (!companies.includes(companyId)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  return null;
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

  return NextResponse.json({ accounts: data });
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

  if (!company_id || !channel || !display_name || !credentials) {
    return NextResponse.json(
      { error: 'company_id, channel, display_name, and credentials are required' },
      { status: 400 },
    );
  }

  const denied = await checkScope(auth.user, company_id, delivery_target);
  if (denied) return denied;

  // Encrypt credentials before storing
  const encryptedCreds = encryptCredentials(credentials);
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

  return NextResponse.json({ account: data }, { status: 201 });
}
