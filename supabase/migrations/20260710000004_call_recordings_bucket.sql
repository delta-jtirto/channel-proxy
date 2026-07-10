-- Private bucket for call recordings. No storage.objects RLS policies are
-- added: every read/write goes through channel-proxy's service_role client
-- (src/lib/db/supabase.ts getServiceClient), which bypasses Storage RLS by
-- default, same posture as webhook_logs (20260624000001). Never leave the
-- only copy of a recording on Twilio's own servers — this bucket is that
-- copy. Playback for the BPO inbox is a server-minted signed URL (Plan 4),
-- not direct client Storage access — hence no public/authenticated policy.
INSERT INTO storage.buckets (id, name, public)
VALUES ('call-recordings', 'call-recordings', false)
ON CONFLICT (id) DO NOTHING;
