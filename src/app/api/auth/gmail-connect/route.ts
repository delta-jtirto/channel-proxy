import { NextResponse, type NextRequest } from 'next/server';
import {
  authenticateRequest,
  getSupportWorkspaceId,
  getUserCompanyIds,
} from '@/lib/auth/middleware';
import { getGmailAuthUrl } from '@/lib/adapters/email/gmail';

/**
 * POST /api/auth/gmail-connect
 * Initiate Gmail OAuth flow. Returns the Google consent URL.
 * Body: {
 *   company_id,
 *   delivery_target?  : 'bpo' | 'support' (default 'bpo')
 *   return_url?       : where the callback redirects after success
 * }
 *
 * Support callers pass delivery_target='support' + their workspace_id as
 * company_id; we verify the JWT's workspace_id claim matches instead of
 * the BPO user_companies link.
 */
export async function POST(req: NextRequest) {
  const auth = await authenticateRequest(req);
  if ('error' in auth) return auth.error;

  const body = await req.json();
  const { company_id, return_url } = body;
  const delivery_target: 'bpo' | 'support' =
    body.delivery_target === 'support' ? 'support' : 'bpo';

  if (!company_id) {
    return NextResponse.json({ error: 'company_id required' }, { status: 400 });
  }

  if (delivery_target === 'support') {
    const ws = getSupportWorkspaceId(auth.user);
    if (!ws || ws !== company_id) {
      return NextResponse.json(
        { error: 'Forbidden — JWT workspace_id does not match the requested tenant' },
        { status: 403 },
      );
    }
  } else {
    const userCompanies = await getUserCompanyIds(auth.user.id);
    if (!userCompanies.includes(company_id)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
  }

  // Encode state for the callback. Carries the upsert scope
  // (delivery_target + tenant) AND the post-callback redirect — the
  // caller knows where they'd like to land, the proxy doesn't.
  const state = Buffer.from(
    JSON.stringify({
      companyId: company_id,
      userId: auth.user.id,
      deliveryTarget: delivery_target,
      returnUrl: typeof return_url === 'string' ? return_url : undefined,
    }),
  ).toString('base64url');

  const authUrl = getGmailAuthUrl(state);

  return NextResponse.json({ url: authUrl });
}
