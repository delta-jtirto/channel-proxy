-- Add host_id to channel_accounts for BPO host mapping.
-- Each channel is mapped to a specific BPO host so messages
-- appear under the correct company in the inbox.
ALTER TABLE channel_accounts ADD COLUMN IF NOT EXISTS host_id TEXT;
