-- Allow 'voice' and 'video' as channel_accounts.channel values. The original
-- CHECK (initial_schema.sql:46) is an unnamed inline constraint; Postgres
-- auto-names it <table>_<column>_check, same convention the company_id+
-- channel UNIQUE constraint relies on in 20260625000002. Drop-and-recreate
-- is the only way to widen a CHECK's allowed set.
--
-- NOTE: the widened set preserves the CURRENT DB allow-list
-- {whatsapp, instagram, line, email, telegram} verbatim and only ADDS
-- voice/video. 'wati' is intentionally NOT added here: it exists in the TS
-- `Channel` union (src/lib/adapters/types.ts) but was never part of this DB
-- CHECK — a pre-existing TS-vs-DB discrepancy this migration does not touch.
ALTER TABLE channel_accounts
  DROP CONSTRAINT IF EXISTS channel_accounts_channel_check;

ALTER TABLE channel_accounts
  ADD CONSTRAINT channel_accounts_channel_check
    CHECK (channel IN ('whatsapp', 'instagram', 'line', 'email', 'telegram', 'voice', 'video'));

-- Exempt voice/video from the single-account-per-channel guard. The partial
-- index channel_accounts_single_per_nonemail_channel (20260625000002:62-64)
-- caps non-email channels at one active row per (company, channel) BECAUSE
-- getChannelAccount() can't disambiguate WhatsApp/LINE inbound. Voice/video
-- DO disambiguate — by the dialed `To` number, exactly like email by mailbox
-- — so a BPO needs many voice numbers per company (one per host). Recreate the
-- index exempting voice/video alongside email. UNIQUE(company_id,channel,handle)
-- (channel_accounts_company_channel_handle_key, added in the same 20260625
-- migration) still prevents duplicate numbers.
DROP INDEX IF EXISTS channel_accounts_single_per_nonemail_channel;

CREATE UNIQUE INDEX channel_accounts_single_per_nonemail_channel
  ON channel_accounts (company_id, channel)
  WHERE channel NOT IN ('email', 'voice', 'video');
