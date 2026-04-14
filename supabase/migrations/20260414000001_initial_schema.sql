-- ============================================================
-- Channel Proxy - Initial Schema
-- ============================================================

-- User profile (basic info, auto-created on Supabase Auth signup)
CREATE TABLE profiles (
    id          UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    full_name   TEXT,
    avatar_url  TEXT,
    created_at  TIMESTAMPTZ DEFAULT now()
);

-- Many-to-many: one agent can manage multiple companies
CREATE TABLE user_companies (
    user_id     UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    company_id  TEXT NOT NULL,
    role        TEXT DEFAULT 'agent' CHECK (role IN ('admin', 'agent', 'viewer')),
    connected_at TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (user_id, company_id)
);

-- Auto-create profile on signup
CREATE OR REPLACE FUNCTION handle_new_user() RETURNS trigger AS $$
BEGIN
  INSERT INTO public.profiles (id, full_name)
  VALUES (NEW.id, NEW.raw_user_meta_data ->> 'full_name');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- Helper: get all company_ids the current user has access to
CREATE OR REPLACE FUNCTION get_user_company_ids() RETURNS SETOF TEXT AS $$
  SELECT company_id FROM public.user_companies WHERE user_id = auth.uid()
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- ============================================================
-- Channel Accounts (1 company = 1 account per channel)
-- ============================================================
CREATE TABLE channel_accounts (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id      TEXT NOT NULL,
    channel         TEXT NOT NULL CHECK (channel IN ('whatsapp', 'instagram', 'line', 'email', 'telegram')),
    display_name    TEXT NOT NULL,
    is_active       BOOLEAN DEFAULT true,
    credentials     TEXT NOT NULL,           -- AES-256-GCM encrypted string
    webhook_secret  TEXT,
    created_at      TIMESTAMPTZ DEFAULT now(),
    updated_at      TIMESTAMPTZ DEFAULT now(),
    UNIQUE(company_id, channel)
);

-- ============================================================
-- Contacts (external people messaging the company)
-- ============================================================
CREATE TABLE contacts (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id          TEXT NOT NULL,
    channel             TEXT NOT NULL,
    channel_contact_id  TEXT NOT NULL,       -- phone, email, IG user ID, LINE user ID
    display_name        TEXT,
    avatar_url          TEXT,
    metadata            JSONB DEFAULT '{}',
    first_seen_at       TIMESTAMPTZ DEFAULT now(),
    last_seen_at        TIMESTAMPTZ DEFAULT now(),
    UNIQUE(company_id, channel, channel_contact_id)
);

CREATE INDEX idx_contacts_lookup ON contacts(company_id, channel, channel_contact_id);

-- ============================================================
-- Conversations
-- ============================================================
CREATE TABLE conversations (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id          TEXT NOT NULL,
    channel             TEXT NOT NULL,
    contact_id          UUID NOT NULL REFERENCES contacts(id),
    account_id          UUID NOT NULL REFERENCES channel_accounts(id),
    channel_thread_id   TEXT,               -- channel's native thread/convo ID
    subject             TEXT,               -- email subject; null for chat channels
    status              TEXT DEFAULT 'active' CHECK (status IN ('active', 'closed', 'archived')),
    last_message_at     TIMESTAMPTZ,
    last_message_preview TEXT,
    unread_count        INT DEFAULT 0,
    message_count       INT DEFAULT 0,
    created_at          TIMESTAMPTZ DEFAULT now(),
    updated_at          TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_conversations_company ON conversations(company_id, last_message_at DESC);
CREATE INDEX idx_conversations_status ON conversations(company_id, status) WHERE status = 'active';

-- ============================================================
-- Messages
-- ============================================================
CREATE TABLE messages (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id     UUID NOT NULL REFERENCES conversations(id),
    company_id          TEXT NOT NULL,
    channel             TEXT NOT NULL,
    direction           TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
    sender_id           TEXT NOT NULL,
    sender_name         TEXT,
    content_type        TEXT NOT NULL DEFAULT 'text',
    text_body           TEXT,
    subject             TEXT,
    attachments         JSONB DEFAULT '[]',
    metadata            JSONB DEFAULT '{}',
    channel_message_id  TEXT,
    status              TEXT DEFAULT 'received',
    error_message       TEXT,
    idempotency_key     TEXT UNIQUE,
    channel_timestamp   TIMESTAMPTZ,
    received_at         TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_messages_conversation ON messages(conversation_id, channel_timestamp DESC);
CREATE INDEX idx_messages_company ON messages(company_id, received_at DESC);

-- ============================================================
-- Webhook Logs (with TTL cleanup via cron)
-- ============================================================
CREATE TABLE webhook_logs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel         TEXT NOT NULL,
    company_id      TEXT,
    raw_payload     JSONB NOT NULL,
    status          TEXT DEFAULT 'received',
    error_message   TEXT,
    processing_ms   INT,
    created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_webhook_logs_created ON webhook_logs(created_at);

-- ============================================================
-- RLS Policies
-- ============================================================
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;

-- Profiles: users can read/update their own
CREATE POLICY "own_profile_select" ON profiles
  FOR SELECT USING (id = auth.uid());
CREATE POLICY "own_profile_update" ON profiles
  FOR UPDATE USING (id = auth.uid());

-- User Companies: users see their own associations
CREATE POLICY "own_companies_select" ON user_companies
  FOR SELECT USING (user_id = auth.uid());
-- Admins can manage company memberships
CREATE POLICY "admin_manage_companies" ON user_companies
  FOR ALL USING (
    company_id IN (
      SELECT company_id FROM user_companies
      WHERE user_id = auth.uid() AND role = 'admin'
    )
  );

-- Data tables: multi-company isolation
CREATE POLICY "company_isolation" ON channel_accounts
  FOR ALL USING (company_id IN (SELECT get_user_company_ids()));

CREATE POLICY "company_isolation" ON contacts
  FOR ALL USING (company_id IN (SELECT get_user_company_ids()));

CREATE POLICY "company_isolation" ON conversations
  FOR ALL USING (company_id IN (SELECT get_user_company_ids()));

CREATE POLICY "company_isolation" ON messages
  FOR ALL USING (company_id IN (SELECT get_user_company_ids()));

-- ============================================================
-- Enable Supabase Realtime
-- ============================================================
ALTER PUBLICATION supabase_realtime ADD TABLE messages;
ALTER PUBLICATION supabase_realtime ADD TABLE conversations;
