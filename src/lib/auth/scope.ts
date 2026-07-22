import { NextResponse } from 'next/server';
import { getSupportWorkspaceId, getUserCompanyIds, type AuthUser } from './middleware';

export type DeliveryTarget = 'bpo' | 'support';

/**
 * Authorize `user` to act on `companyId` under a delivery target.
 *   - 'bpo'     → their `user_companies` row must link them to it.
 *   - 'support' → their JWT `app_metadata.workspace_id` must equal it.
 * Returns null on success, a 403 NextResponse on rejection.
 *
 * Single source of truth for the dual-tenant check — the accounts,
 * accounts/[id], gmail-connect, and messages/send routes all authorize
 * through here so a support operator (no user_companies row) is never
 * rejected by the BPO-only path.
 */
export async function checkScope(
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
