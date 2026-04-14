import { NextResponse, type NextRequest } from 'next/server';
import { authenticateRequest, getUserCompanyIds } from '@/lib/auth/middleware';
import { getServiceClient } from '@/lib/db/supabase';

/**
 * GET /api/proxy/conversations/:id/messages?limit=50&offset=0
 * List messages in a conversation, ordered by timestamp ASC.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await authenticateRequest(req);
  if ('error' in auth) return auth.error;

  const { id: conversationId } = await params;
  const limit = parseInt(req.nextUrl.searchParams.get('limit') ?? '50', 10);
  const offset = parseInt(req.nextUrl.searchParams.get('offset') ?? '0', 10);

  const supabase = getServiceClient();

  // Verify the conversation exists and the user has access
  const { data: convo } = await supabase
    .from('conversations')
    .select('company_id')
    .eq('id', conversationId)
    .single();

  if (!convo) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const userCompanies = await getUserCompanyIds(auth.user.id);
  if (!userCompanies.includes(convo.company_id)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { data, error, count } = await supabase
    .from('messages')
    .select('*', { count: 'exact' })
    .eq('conversation_id', conversationId)
    .order('channel_timestamp', { ascending: true })
    .range(offset, offset + limit - 1);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    messages: data,
    total: count,
    limit,
    offset,
  });
}
