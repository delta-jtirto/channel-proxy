import { type NextRequest, NextResponse } from 'next/server';
import { getUserClient } from '@/lib/db/supabase';

export interface AuthUser {
  id: string;
  email: string;
  /** Raw app_metadata from the JWT. Authoritative for non-BPO product
   *  claims (e.g. Support's `workspace_id`). Optional because BPO users
   *  don't necessarily carry one. */
  app_metadata?: Record<string, unknown>;
  /** Bearer token used to authenticate this request. Threaded through so
   *  downstream calls (e.g. getUserCompanyIds RPC) can run as the user
   *  and inherit the same auth.uid()-aware fallback logic the frontend
   *  does. */
  accessToken: string;
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
      accessToken: token,
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
 *
 * Delegates to the `get_user_company_ids` RPC defined in the AI CS BPO
 * repo's Postgres functions so the same fallback logic — JWT claim
 * first, then user_companies table, then a default of "delta-hq" for
 * any authenticated user — is the single source of truth for both
 * frontend (BPO/Support) and the proxy. Avoids the proxy 403ing on
 * users the frontend would otherwise see (e.g. when an alias account
 * like james.tirto+ems hasn't been added to user_companies yet but
 * BPO is single-tenant by design).
 *
 * Falls back to a raw user_companies query on RPC failure so a missing
 * RPC doesn't fail closed permanently — that scenario shouldn't happen
 * because the two repos share one Supabase project, but the
 * defensive read is cheap.
 */
export async function getUserCompanyIds(
  userId: string,
  accessToken?: string,
): Promise<string[]> {
  if (accessToken) {
    const userClient = getUserClient(accessToken);
    const { data, error } = await userClient.rpc('get_user_company_ids');
    if (!error && Array.isArray(data)) {
      return (data as unknown[]).filter((v): v is string => typeof v === 'string');
    }
    if (error) {
      console.warn('[auth] get_user_company_ids RPC failed, falling back:', error.message);
    }
  }

  // Fallback: legacy direct read. Used when no token is available
  // OR if the RPC was unavailable. Does not carry the "default to
  // delta-hq" rule — keep that in the RPC so the schema-level
  // multi-tenancy story has exactly one writer.
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
