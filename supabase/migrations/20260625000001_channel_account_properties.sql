-- ============================================================
-- B1: channel <-> property SET binding
-- ============================================================
-- One channel_accounts row may serve a SET of BPO property ids.
--   * ZERO rows for an account == "all properties" (the legacy
--     default, so every already-connected account keeps working
--     untouched).
--   * One-or-more rows == the account is scoped to exactly that set.
--
-- prop_id is FREE-TEXT and intentionally has NO FK: the BPO
-- 'properties' table lives in a DIFFERENT Supabase project, so we
-- cannot reference it here. We only store the string id the BPO side
-- knows it by; the API cannot validate it (cross-database).
--
-- company_id is denormalised onto this table (rather than joined
-- through channel_accounts) so the RLS policy can mirror
-- channel_accounts' company_isolation pattern verbatim. The accounts
-- API is responsible for writing it equal to the parent account's
-- company_id (nothing in the DB enforces that equality).

CREATE TABLE channel_account_properties (
    account_id  UUID NOT NULL
                  REFERENCES channel_accounts(id) ON DELETE CASCADE,
    prop_id     TEXT NOT NULL,
    company_id  TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id, prop_id)
);

-- Reverse lookup: "which accounts serve property X for this company?"
-- The PK (account_id, prop_id) can't serve this query.
CREATE INDEX idx_cap_company_prop
    ON channel_account_properties (company_id, prop_id);

COMMENT ON TABLE channel_account_properties IS
  'Set binding from a channel_accounts row to BPO property ids. 0 rows = all properties (legacy default). prop_id is free text -- the BPO properties table lives in a separate Supabase, so there is no FK.';
COMMENT ON COLUMN channel_account_properties.prop_id IS
  'BPO property id as a string. No FK (cross-database).';
COMMENT ON COLUMN channel_account_properties.company_id IS
  'Denormalised copy of the parent channel_accounts.company_id, kept in sync by the accounts API so RLS can mirror channel_accounts.';

-- ------------------------------------------------------------
-- RLS -- mirror channel_accounts "company_isolation" exactly.
-- ------------------------------------------------------------
ALTER TABLE channel_account_properties ENABLE ROW LEVEL SECURITY;

CREATE POLICY "company_isolation" ON channel_account_properties
  FOR ALL USING (company_id IN (SELECT get_user_company_ids()));
