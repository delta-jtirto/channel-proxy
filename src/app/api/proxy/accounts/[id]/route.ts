import { NextResponse, type NextRequest } from 'next/server';
import { authenticateRequest, getUserCompanyIds } from '@/lib/auth/middleware';
import { getServiceClient } from '@/lib/db/supabase';
import { encryptCredentials, decryptCredentials } from '@/lib/credentials';

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
    .select('id, company_id, channel, display_name, is_active, created_at, updated_at')
    .eq('id', id)
    .single();

  if (error || !data) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const userCompanies = await getUserCompanyIds(auth.user.id);
  if (!userCompanies.includes(data.company_id)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

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
    .select('company_id, credentials')
    .eq('id', id)
    .single();

  if (!existing) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const userCompanies = await getUserCompanyIds(auth.user.id);
  if (!userCompanies.includes(existing.company_id)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const updates: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };

  if (body.display_name) updates.display_name = body.display_name;
  if (body.is_active !== undefined) updates.is_active = body.is_active;
  if (body.host_id !== undefined) updates.host_id = body.host_id || null;

  // Full replacement: body.credentials = full new creds object (legacy path)
  if (body.credentials) updates.credentials = encryptCredentials(body.credentials);

  // Partial update: body.credentials_patch = { access_token: 'new...' }
  // Decrypt existing creds, merge patch, re-encrypt. Lets the UI rotate
  // a single field (e.g. expired access token) without re-pasting all 5.
  if (body.credentials_patch && typeof body.credentials_patch === 'object') {
    const current = decryptCredentials(existing.credentials);
    const merged = { ...current, ...body.credentials_patch };
    updates.credentials = encryptCredentials(merged);
  }

  const { data, error } = await supabase
    .from('channel_accounts')
    .update(updates)
    .eq('id', id)
    .select('id, company_id, channel, display_name, is_active, host_id, updated_at')
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
    .select('company_id')
    .eq('id', id)
    .single();

  if (!existing) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const userCompanies = await getUserCompanyIds(auth.user.id);
  if (!userCompanies.includes(existing.company_id)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { error } = await supabase.from('channel_accounts').delete().eq('id', id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return new Response(null, { status: 204 });
}
