import { NextResponse, type NextRequest } from 'next/server';
import { authenticateRequest, getUserCompanyIds } from '@/lib/auth/middleware';
import { getServiceClient } from '@/lib/db/supabase';

/**
 * GET /api/proxy/conversations?company_id=X&status=active&limit=20&offset=0
 * List conversations for a company, ordered by last_message_at DESC.
 */
export async function GET(req: NextRequest) {
  const auth = await authenticateRequest(req);
  if ('error' in auth) return auth.error;

  const companyId = req.nextUrl.searchParams.get('company_id');
  const status = req.nextUrl.searchParams.get('status') ?? 'active';
  const limit = parseInt(req.nextUrl.searchParams.get('limit') ?? '20', 10);
  const offset = parseInt(req.nextUrl.searchParams.get('offset') ?? '0', 10);

  if (!companyId) {
    return NextResponse.json({ error: 'company_id required' }, { status: 400 });
  }

  const userCompanies = await getUserCompanyIds(auth.user.id);
  if (!userCompanies.includes(companyId)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const supabase = getServiceClient();
  const { data, error, count } = await supabase
    .from('conversations')
    .select(
      `
      id, company_id, channel, channel_thread_id, subject, status,
      last_message_at, last_message_preview, unread_count, message_count,
      created_at, updated_at,
      contacts!inner (id, channel_contact_id, display_name, avatar_url)
    `,
      { count: 'exact' },
    )
    .eq('company_id', companyId)
    .eq('status', status)
    .order('last_message_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    conversations: data,
    total: count,
    limit,
    offset,
  });
}
