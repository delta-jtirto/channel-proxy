import { NextResponse, type NextRequest } from 'next/server';
import { authenticateRequest, getUserCompanyIds } from '@/lib/auth/middleware';
import { getServiceClient } from '@/lib/db/supabase';
import { encryptCredentials } from '@/lib/credentials';

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

  // Verify user has access to this company
  const userCompanies = await getUserCompanyIds(auth.user.id);
  if (!userCompanies.includes(companyId)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from('channel_accounts')
    .select('id, company_id, channel, display_name, is_active, created_at, updated_at')
    .eq('company_id', companyId)
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
  const { company_id, channel, display_name, credentials } = body;

  if (!company_id || !channel || !display_name || !credentials) {
    return NextResponse.json(
      { error: 'company_id, channel, display_name, and credentials are required' },
      { status: 400 },
    );
  }

  // Verify user has admin access to this company
  const userCompanies = await getUserCompanyIds(auth.user.id);
  if (!userCompanies.includes(company_id)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // Encrypt credentials before storing
  const encryptedCreds = encryptCredentials(credentials);

  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from('channel_accounts')
    .insert({
      company_id,
      channel,
      display_name,
      credentials: encryptedCreds,
    })
    .select('id, company_id, channel, display_name, is_active, created_at')
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
