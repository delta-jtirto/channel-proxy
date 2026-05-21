import { type NextRequest, NextResponse } from 'next/server';
import { getUserClient } from '@/lib/db/supabase';

export interface AuthUser {
  id: string;
  email: string;
  /** Raw app_metadata from the JWT. Authoritative for non-BPO product
   *  claims (e.g. Support's `workspace_id`). Optional because BPO users
   *  don't necessarily carry one. */
  app_metadata?: Record<string, unknown>;
}

/**
 * Extract and validate the Supabase Auth user from a request.
 * Returns the user if valid, or a 401 Response.
 */
export async function authenticateRequest(
  req: NextRequest,
): Promise<{ user: AuthUser } | { error: NextResponse }> {
  const authHeader = req.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return {
      error: NextResponse.json(
        { error: 'Missing or invalid Authorization header' },
        { status: 401 },
      ),
    };
  }

  const token = authHeader.slice(7);
  const supabase = getUserClient(token);

  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) {
    return {
      error: NextResponse.json(
        { error: 'Invalid or expired token' },
        { status: 401 },
      ),
    };
  }

  return {
    user: {
      id: user.id,
      email: user.email ?? '',
      app_metadata: user.app_metadata as Record<string, unknown> | undefined,
    },
  };
}

/**
 * Read the Support workspace claim from a user's app_metadata. Returns
 * null if the claim is missing — the user isn't a Support operator.
 */
export function getSupportWorkspaceId(user: AuthUser): string | null {
  const raw = user.app_metadata?.workspace_id;
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

/**
 * Get company IDs accessible by a user.
 */
export async function getUserCompanyIds(userId: string): Promise<string[]> {
  const { getServiceClient } = await import('@/lib/db/supabase');
  const supabase = getServiceClient();

  const { data, error } = await supabase
    .from('user_companies')
    .select('company_id')
    .eq('user_id', userId);

  if (error) {
    throw new Error(`Failed to fetch user companies: ${error.message}`);
  }

  return (data ?? []).map((row) => row.company_id);
}
