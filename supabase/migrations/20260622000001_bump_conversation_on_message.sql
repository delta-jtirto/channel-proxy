CREATE OR REPLACE FUNCTION public.bump_conversation_on_message(p_conversation_id uuid, p_preview text, p_direction text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE public.conversations
  SET last_message_at = now(), last_message_preview = p_preview, last_message_direction = p_direction,
      updated_at = now(), status = 'active',
      message_count = message_count + 1,
      unread_count = unread_count + (CASE WHEN p_direction = 'inbound' THEN 1 ELSE 0 END)
  WHERE id = p_conversation_id;
$$;
GRANT EXECUTE ON FUNCTION public.bump_conversation_on_message(uuid, text, text) TO service_role;
