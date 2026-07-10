-- upsert_call_message: atomic create-or-update of ONE messages row per call,
-- across its whole lifecycle (ringing -> in-progress -> completed, +
-- no-answer/busy/failed/canceled variants, each a separate Twilio webhook
-- hit). Mirrors bump_conversation_on_message's pattern of collapsing a
-- read-modify-write race into one DB round-trip: `metadata` JSONB-merges
-- (each event adds/refines fields, never wholesale-replaces what a prior
-- event wrote); `text_body` and `channel_timestamp` are overwritten (each
-- event's view of the call supersedes the previous one).
--
-- `xmax = 0` in the RETURNING clause is the standard Postgres idiom for
-- "was this row just INSERTed (true) or did the ON CONFLICT UPDATE branch
-- fire (false)" — the caller uses is_new to decide whether to bump
-- conversation counts (first-ever event for this CallSid) or just refresh
-- the preview (a later lifecycle event on an already-counted call).
CREATE OR REPLACE FUNCTION public.upsert_call_message(
  p_conversation_id uuid,
  p_company_id text,
  p_channel text,
  p_direction text,
  p_sender_id text,
  p_channel_message_id text,
  p_idempotency_key text,
  p_text_body text,
  p_metadata_patch jsonb,
  p_channel_timestamp timestamptz
) RETURNS TABLE(id uuid, is_new boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN QUERY
  INSERT INTO messages (
    conversation_id, company_id, channel, direction, sender_id,
    content_type, text_body, metadata, channel_message_id,
    idempotency_key, status, channel_timestamp, received_at
  ) VALUES (
    p_conversation_id, p_company_id, p_channel, p_direction, p_sender_id,
    'call', p_text_body, p_metadata_patch, p_channel_message_id,
    p_idempotency_key, 'received', p_channel_timestamp, now()
  )
  ON CONFLICT (idempotency_key) DO UPDATE SET
    text_body = EXCLUDED.text_body,
    metadata = messages.metadata || EXCLUDED.metadata,
    channel_timestamp = EXCLUDED.channel_timestamp
  RETURNING messages.id, (xmax = 0);
END;
$$;

GRANT EXECUTE ON FUNCTION public.upsert_call_message(
  uuid, text, text, text, text, text, text, text, jsonb, timestamptz
) TO service_role;

-- upsert_call_metadata_only: a narrower sibling for events that update an
-- ALREADY-EXISTING call message but must NOT touch text_body/
-- channel_timestamp — e.g. the recording-status callback (Task 6), which
-- only ever learns recording_url/duration well after the call's lifecycle
-- text has already been set by upsert_call_message. Reusing
-- upsert_call_message for this would force the caller to pass a text_body
-- (blanking the real preview) since that function's ON CONFLICT branch
-- unconditionally overwrites both columns. A plain UPDATE keyed by
-- idempotency_key (no INSERT branch — the row must already exist) is all
-- this needs.
CREATE OR REPLACE FUNCTION public.upsert_call_metadata_only(
  p_idempotency_key text,
  p_metadata_patch jsonb
) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE public.messages
  SET metadata = metadata || p_metadata_patch
  WHERE idempotency_key = p_idempotency_key;
$$;

GRANT EXECUTE ON FUNCTION public.upsert_call_metadata_only(text, jsonb) TO service_role;
