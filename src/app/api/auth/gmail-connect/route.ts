import { NextResponse, type NextRequest } from 'next/server';
import { authenticateRequest, getUserCompanyIds } from '@/lib/auth/middleware';
import { getGmailAuthUrl } from '@/lib/adapters/email/gmail';

/**
 * POST /api/auth/gmail-connect
 * Initiate Gmail OAuth flow. Returns the Google consent URL.
 * Body: { company_id }
 */
export async function POST(req: NextRequest) {
  const auth = await authenticateRequest(req);
  if ('error' in auth) return auth.error;

  const { company_id } = await req.json();
  if (!company_id) {
    return NextResponse.json({ error: 'company_id required' }, { status: 400 });
  }

  const userCompanies = await getUserCompanyIds(auth.user.id);
  if (!userCompanies.includes(company_id)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // Encode state for the callback
  const state = Buffer.from(
    JSON.stringify({ companyId: company_id, userId: auth.user.id }),
  ).toString('base64url');

  const authUrl = getGmailAuthUrl(state);

  return NextResponse.json({ url: authUrl });
}
