import { NextResponse } from 'next/server';

/**
 * GET /api/cron/renew-graph-subscriptions
 * Renew Microsoft Graph subscriptions that expire every 3 days.
 * Runs daily via Vercel Cron.
 *
 * TODO (Phase 2 - Email): Implement Graph subscription renewal.
 */
export async function GET(req: Request) {
  const authHeader = req.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  // Phase 2: Iterate Microsoft accounts and renew subscriptions
  return NextResponse.json({ message: 'Not yet implemented (Phase 2)' });
}
