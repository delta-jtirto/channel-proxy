-- Diarized transcript, one row per utterance. INSERT-only table (not a
-- JSONB array on messages) because Plan 6's live copilot appends rows in
-- real time as speech is transcribed — a JSONB array would need a full
-- read-modify-write per partial event, racy under Realtime-frequency writes.
--
-- speaker/text/is_final/offset_ms field names and semantics are provisional
-- (v0, additive-only) pending Plan 2's spike confirming the actual Twilio
-- real-time transcription event shape [SPIKE-VERIFY — see Task 7].
CREATE TABLE call_utterances (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id        UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    company_id        TEXT NOT NULL,
    seq               INT NOT NULL,
    speaker           TEXT NOT NULL CHECK (speaker IN ('agent', 'guest', 'system')),
    text              TEXT NOT NULL,
    is_final          BOOLEAN NOT NULL DEFAULT true,
    offset_ms         INT,
    channel_timestamp TIMESTAMPTZ NOT NULL,
    created_at        TIMESTAMPTZ DEFAULT now(),
    UNIQUE (message_id, seq)
);

CREATE INDEX idx_call_utterances_message ON call_utterances(message_id, seq);

ALTER TABLE call_utterances ENABLE ROW LEVEL SECURITY;

CREATE POLICY "company_isolation" ON call_utterances
  FOR ALL USING (company_id IN (SELECT get_user_company_ids()));

-- Realtime so Plan 6's copilot panel can subscribe to new utterances as
-- they land, same mechanism as messages/conversations today.
ALTER PUBLICATION supabase_realtime ADD TABLE call_utterances;

COMMENT ON TABLE call_utterances IS
  'Diarized call transcript, one row per utterance. Plan 3 writes final
   post-call utterances (if the spike''s mechanism delivers them that way);
   Plan 6 appends live partial/final utterances during the call. FK to the
   call''s own messages.id (content_type=''call'').';
