-- ============================================================
-- B1: relax UNIQUE(company_id, channel) -> (company_id, channel, handle)
-- ============================================================
-- Immediate use case: a 2nd Gmail for one property. Email inbound
-- already disambiguates accounts by mailbox
-- (webhooks/email/[companyId] loads ALL active email rows and filters
-- in JS by handle/display_name == the Pub/Sub emailAddress), so
-- multiple email accounts per company are safe.
--
-- WA/IG/LINE multi-account GUARD
-- ------------------------------------------------------------
-- WhatsApp, Instagram, LINE and Telegram inbound resolve THE account
-- via getChannelAccount(company_id, channel) in src/lib/db/queries.ts.
-- That lookup filters only (company_id, channel, is_active) and has no
-- per-payload disambiguator, so a 2nd active non-email account for one
-- company is ambiguous and would break/mis-route inbound. We therefore
-- KEEP non-email channels effectively one-per-(company,channel) via the
-- partial unique index in step 4. Multi-account for non-email is FUTURE
-- WORK gated on teaching those webhooks to route by phone_number_id /
-- ig_user_id / channel_id and dropping that index.
--
-- Two correctness traps handled below:
--   (a) NULL handles. handle was added nullable with no default
--       (20260522000000), so legacy rows have handle = NULL. Postgres
--       treats NULLs as DISTINCT in a UNIQUE index, so a plain
--       UNIQUE(company_id, channel, handle) would let UNLIMITED
--       NULL-handle rows collide for one (company_id, channel) --
--       silently defeating the constraint. So we BACKFILL every NULL
--       handle to a deterministic, collision-free sentinel and make
--       handle NOT NULL FIRST.
--   (b) The old constraint is inline/unnamed; Postgres auto-named it
--       channel_accounts_company_id_channel_key. We drop it by that
--       convention name with IF EXISTS.

-- 1. Backfill NULL handles to a deterministic non-colliding value.
--    Uses the row's own id so it is unique and stable. The 'legacy:'
--    prefix makes backfilled placeholders obvious in the settings UI
--    and greppable if a one-shot real-handle backfill runs later.
UPDATE channel_accounts
   SET handle = 'legacy:' || id::text
 WHERE handle IS NULL;

-- 2. handle is now mandatory -- every future row carries one.
ALTER TABLE channel_accounts
  ALTER COLUMN handle SET NOT NULL;

-- 3. Swap the constraints: drop the old (company_id, channel) key,
--    add (company_id, channel, handle) so a 2nd Gmail can coexist.
ALTER TABLE channel_accounts
  DROP CONSTRAINT IF EXISTS channel_accounts_company_id_channel_key;

ALTER TABLE channel_accounts
  ADD CONSTRAINT channel_accounts_company_channel_handle_key
    UNIQUE (company_id, channel, handle);

-- 4. GUARD: keep WhatsApp/Instagram/LINE/Telegram exactly one row per
--    (company_id, channel) until getChannelAccount() can disambiguate.
--    Email (and any future explicitly multi-account channel) is exempt.
--    This restores the 23505 the accounts API maps to its 409 for
--    non-email channels. Remove in a FUTURE migration once the webhook
--    lookups route by inbound identifier.
CREATE UNIQUE INDEX channel_accounts_single_per_nonemail_channel
  ON channel_accounts (company_id, channel)
  WHERE channel <> 'email';
