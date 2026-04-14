import { NextResponse } from 'next/server';
import { getServiceClient } from '@/lib/db/supabase';

/**
 * GET /api/cron/cleanup-webhook-logs
 * Delete webhook logs older than 14 days.
 * Runs daily via Vercel Cron.
 */
export async function GET(req: Request) {
  // Verify cron secret
  const authHeader = req.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  const supabase = getServiceClient();
  const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();

  const { count, error } = await supabase
    .from('webhook_logs')
    .delete()
    .lt('created_at', cutoff);

  if (error) {
    console.error('Webhook log cleanup failed:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ deleted: count ?? 0 });
}
