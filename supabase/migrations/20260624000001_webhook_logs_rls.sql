-- webhook_logs is an internal ops/audit table written only by the backend
-- (service_role). Enable RLS to block all Data API access — no client
-- policies needed because service_role bypasses RLS by default.
ALTER TABLE public.webhook_logs ENABLE ROW LEVEL SECURITY;
