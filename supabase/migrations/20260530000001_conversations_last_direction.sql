-- Add `last_message_direction` to `conversations` so the BPO inbox can
-- compute SLA correctly without round-tripping for the latest message.
--
-- Why this matters: BPO's SLA timer should pause the moment we reply.
-- Today it can only see `last_message_at` (timestamp, no sender info)
-- on the conversation row, so threads we've already responded to keep
-- showing red "3d urgent" until a new guest message lands. Carrying the
-- direction of the last message on the conversation row collapses that
-- decision into one read instead of N+1.
--
-- Maintenance plan:
--   * Webhook ingest (`upsertConversation`) writes 'inbound'
--   * Send route (POST /api/proxy/messages/send) writes 'outbound'
--   * Both writes are co-located with the existing `last_message_at`
--     update so the two fields can never drift.
--
-- Backfill: derive from `messages.direction` of the most recent message
-- per conversation. Conversations with zero messages get null (no
-- direction is also a valid signal — handled at read time).

BEGIN;

ALTER TABLE conversations
  ADD COLUMN last_message_direction TEXT
  CHECK (last_message_direction IN ('inbound', 'outbound'));

-- One-shot backfill. Uses DISTINCT ON to pluck the most recent message
-- per conversation in a single pass — cheaper than a correlated subquery
-- when conversation counts are large.
WITH latest AS (
  SELECT DISTINCT ON (conversation_id)
    conversation_id,
    direction
  FROM messages
  ORDER BY conversation_id, channel_timestamp DESC NULLS LAST, received_at DESC
)
UPDATE conversations c
SET last_message_direction = latest.direction
FROM latest
WHERE c.id = latest.conversation_id;

COMMIT;
