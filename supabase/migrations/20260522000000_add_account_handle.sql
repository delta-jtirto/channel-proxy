-- Add channel_accounts.handle so the settings UI can show the actual
-- identifier ('support@deltahq.com', '+819012345678', '@deltahq_ig',
-- 'line-bot-id', …) instead of relying on the operator-typed
-- display_name.
--
-- Source of truth: the channel-specific credential field, extracted
-- at create-time in /api/proxy/accounts (POST) so the handle is
-- persisted alongside the row without leaking the full credentials
-- bundle to clients.
--
-- Nullable + no default — existing rows stay handle=null. The
-- accounts POST handler populates it for new connections; a one-shot
-- backfill of old rows lives outside this migration (the encrypted
-- credentials are still on disk, so it can run later).

alter table channel_accounts
  add column if not exists handle text;

comment on column channel_accounts.handle is
  'Human-readable identifier for this account. For email: the mailbox '
  'address. For WhatsApp: the phone_number_id (until a Meta lookup adds '
  'the dialed E.164). For Instagram: the ig_user_id. For LINE: the '
  'channel_id. Always safe to surface to settings UIs — never carries '
  'a secret.';
