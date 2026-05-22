import { NextResponse, type NextRequest } from 'next/server';
import {
  authenticateRequest,
  getSupportWorkspaceId,
  getUserCompanyIds,
  type AuthUser,
} from '@/lib/auth/middleware';
import { getServiceClient } from '@/lib/db/supabase';
import { encryptCredentials, decryptCredentials } from '@/lib/credentials';

/** Same shape as accounts/route.ts — duplicate it locally so a future
 *  change to credential schemas only touches one file at a time. */
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
 * Verify the caller can touch an existing account row, regardless of
 * whether it belongs to BPO or Support. Mirrors the scope check in
 * /api/proxy/accounts/route.ts: a Support account is reachable only by
 * a user whose JWT `workspace_id` claim equals the row's company_id;
 * a BPO account is reachable via user_companies. */
async function checkExistingScope(
  user: AuthUser,
  row: { company_id: string; delivery_target?: string | null },
): Promise<NextResponse | null> {
  if ((row.delivery_target ?? 'bpo') === 'support') {
    const ws = getSupportWorkspaceId(user);
    if (!ws || ws !== row.company_id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    return null;
  }
  const companies = await getUserCompanyIds(user.id, user.accessToken);
  if (!companies.includes(row.company_id)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  return null;
}

/**
 * GET /api/proxy/accounts/:id
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await authenticateRequest(req);
  if ('error' in auth) return auth.error;

  const { id } = await params;
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from('channel_accounts')
    .select('id, company_id, channel, display_name, handle, is_active, delivery_target, created_at, updated_at')
    .eq('id', id)
    .single();

  if (error || !data) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const denied = await checkExistingScope(auth.user, data);
  if (denied) return denied;

  return NextResponse.json({ account: data });
}

/**
 * PUT /api/proxy/accounts/:id
 * Update credentials or display_name.
 */
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await authenticateRequest(req);
  if ('error' in auth) return auth.error;

  const { id } = await params;
  const body = await req.json();

  const supabase = getServiceClient();

  // Get existing account to verify access AND for credentials_patch merging
  const { data: existing } = await supabase
    .from('channel_accounts')
    .select('company_id, channel, credentials, delivery_target')
    .eq('id', id)
    .single();

  if (!existing) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const denied = await checkExistingScope(auth.user, existing);
  if (denied) return denied;

  const updates: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };

  if (body.display_name) updates.display_name = body.display_name;
  if (body.is_active !== undefined) updates.is_active = body.is_active;
  if (body.host_id !== undefined) updates.host_id = body.host_id || null;

  // Full replacement: body.credentials = full new creds object (legacy path)
  if (body.credentials) {
    updates.credentials = encryptCredentials(body.credentials);
    // Re-extract the handle so the settings UI keeps showing the right
    // mailbox / phone / id when the operator rotates credentials.
    updates.handle = extractHandle(existing.channel as string, body.credentials);
  }

  // Partial update: body.credentials_patch = { access_token: 'new...' }
  // Decrypt existing creds, merge patch, re-encrypt. Lets the UI rotate
  // a single field (e.g. expired access token) without re-pasting all 5.
  if (body.credentials_patch && typeof body.credentials_patch === 'object') {
    const current = decryptCredentials(existing.credentials);
    const merged = { ...current, ...body.credentials_patch };
    updates.credentials = encryptCredentials(merged);
    updates.handle = extractHandle(existing.channel as string, merged);
  }

  const { data, error } = await supabase
    .from('channel_accounts')
    .update(updates)
    .eq('id', id)
    .select('id, company_id, channel, display_name, handle, is_active, host_id, updated_at')
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ account: data });
}

/**
 * DELETE /api/proxy/accounts/:id
 * Disconnect a channel account.
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await authenticateRequest(req);
  if ('error' in auth) return auth.error;

  const { id } = await params;
  const supabase = getServiceClient();

  const { data: existing } = await supabase
    .from('channel_accounts')
    .select('company_id, delivery_target')
    .eq('id', id)
    .single();

  if (!existing) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const denied = await checkExistingScope(auth.user, existing);
  if (denied) return denied;

  const { error } = await supabase.from('channel_accounts').delete().eq('id', id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return new Response(null, { status: 204 });
}
