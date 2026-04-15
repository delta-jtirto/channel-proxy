-- Add last_webhook_at to channel_accounts for webhook verification status.
-- Used by the Channels settings UI to show yellow "Awaiting verification"
-- vs green "Connected" badge.
ALTER TABLE channel_accounts ADD COLUMN IF NOT EXISTS last_webhook_at TIMESTAMPTZ;
