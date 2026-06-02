import { NextResponse, type NextRequest } from 'next/server';
import { authenticateRequest, getUserCompanyIds } from '@/lib/auth/middleware';
import { getServiceClient } from '@/lib/db/supabase';
import { decryptCredentials } from '@/lib/credentials';
import { registry } from '@/lib/adapters/registry';
import type { Channel } from '@/lib/adapters/types';

// Import all adapters to register them
import '@/lib/adapters/whatsapp';
import '@/lib/adapters/wati';
import '@/lib/adapters/instagram';
import '@/lib/adapters/line';
// Email uses the SMTP outbound adapter (which also registers emailInbound).
// Do NOT import gmail.ts directly — it no longer self-registers.
import '@/lib/adapters/email/smtp';

/**
 * POST /api/proxy/messages/send
 * Send an outbound message through a channel.
 *
 * Body: { conversation_id, text, content_type?, attachments? }
 */
export async function POST(req: NextRequest) {
  const auth = await authenticateRequest(req);
  if ('error' in auth) return auth.error;

  const body = await req.json();
  const { conversation_id, text, content_type, attachments, metadata } = body;

  if (!conversation_id || !text) {
    return NextResponse.json(
      { error: 'conversation_id and text are required' },
      { status: 400 },
    );
  }

  const supabase = getServiceClient();

  // Get conversation with contact and account details
  const { data: convo } = await supabase
    .from('conversations')
    .select(`
      id, company_id, channel, account_id, channel_thread_id, subject,
      contacts!inner (id, channel_contact_id, display_name)
    `)
    .eq('id', conversation_id)
    .single();

  if (!convo) {
    return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
  }

  // Verify user access
  const userCompanies = await getUserCompanyIds(auth.user.id, auth.user.accessToken);
  if (!userCompanies.includes(convo.company_id)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // Get channel account credentials
  const { data: account } = await supabase
    .from('channel_accounts')
    .select('credentials, is_active')
    .eq('id', convo.account_id)
    .single();

  if (!account || !account.is_active) {
    return NextResponse.json(
      { error: 'Channel account is inactive or not found' },
      { status: 400 },
    );
  }

  // Get the outbound adapter
  const adapter = registry.getOutbound(convo.channel as Channel);
  if (!adapter) {
    return NextResponse.json(
      { error: `No outbound adapter for channel: ${convo.channel}` },
      { status: 400 },
    );
  }

  // Decrypt credentials and send
  const creds = decryptCredentials(account.credentials);

  const contactRaw = convo.contacts;
  const contact = (Array.isArray(contactRaw) ? contactRaw[0] : contactRaw) as {
    id: string;
    channel_contact_id: string;
    display_name: string;
  };

  if (!contact?.channel_contact_id) {
    return NextResponse.json({ error: 'Contact not found for this conversation' }, { status: 400 });
  }

  // Build channel-specific metadata (email needs thread ID and subject for replies)
  const outboundMetadata: Record<string, unknown> = { ...metadata };
  if (convo.channel === 'email') {
    // SMTP adapter uses this as RFC 5322 In-Reply-To / References header.
    // imap-fetch stores the original Message-ID header (wrapped in <...>)
    // into conversations.channel_thread_id, so we forward it as-is.
    if (convo.channel_thread_id && !outboundMetadata.in_reply_to_header) {
      outboundMetadata.in_reply_to_header = convo.channel_thread_id;
    }
    // Kept for backwards-compat if Gmail OAuth send is ever reintroduced.
    if (convo.channel_thread_id && !outboundMetadata.gmail_thread_id) {
      outboundMetadata.gmail_thread_id = convo.channel_thread_id;
    }
    if (convo.subject && !outboundMetadata.subject) {
      outboundMetadata.subject = convo.subject.startsWith('Re:')
        ? convo.subject
        : `Re: ${convo.subject}`;
    }
  }

  let result: Awaited<ReturnType<typeof adapter.send>>;
  try {
    result = await adapter.send(
      creds,
      { conversation_id, text, content_type, attachments, metadata: outboundMetadata },
      contact.channel_contact_id,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Send failed';
    console.error('adapter.send threw:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }

  if (result.status === 'failed') {
    return NextResponse.json(
      { error: result.error_message ?? 'Send failed' },
      { status: 502 },
    );
  }

  // Store the outbound message
  // If the client signals this is a bot auto-reply (metadata.source === 'bot'),
  // use a 'bot:' prefixed sender_id so consumers can render it differently.
  const isBot = metadata?.source === 'bot';
  const senderId = isBot ? 'bot:auto-reply' : `company:${auth.user.id}`;
  const senderName = isBot ? 'AI Auto-Reply' : auth.user.email;

  const now = new Date().toISOString();
  // Forward the frontend-generated client_message_id so it can dedupe its
  // optimistic bubble against this row when Realtime fires. Sourced from the
  // body metadata (set by proxy-send.ts) or the Idempotency-Key header.
  const clientMessageId =
    (metadata?.client_message_id as string | undefined) ??
    req.headers.get('idempotency-key') ??
    null;

  const { data: message, error: insertError } = await supabase
    .from('messages')
    .insert({
      conversation_id,
      company_id: convo.company_id,
      channel: convo.channel,
      direction: 'outbound',
      sender_id: senderId,
      sender_name: senderName,
      content_type: content_type ?? 'text',
      text_body: text,
      attachments: attachments ?? [],
      metadata: metadata ?? {},
      channel_message_id: result.channel_message_id,
      client_message_id: clientMessageId,
      status: result.status,
      idempotency_key: `outbound_${result.channel_message_id}`,
      channel_timestamp: now,
      received_at: now,
    })
    .select('id')
    .single();

  if (insertError) {
    console.error('Failed to store outbound message:', insertError);
  }

  // Update conversation last message. `last_message_direction = 'outbound'`
  // is what the BPO inbox reads to pause the SLA clock — every send here
  // is by definition a reply from our side.
  await supabase
    .from('conversations')
    .update({
      last_message_at: now,
      last_message_preview: text.slice(0, 200),
      last_message_direction: 'outbound',
      message_count: (convo as Record<string, unknown>).message_count
        ? ((convo as Record<string, unknown>).message_count as number) + 1
        : 1,
      updated_at: now,
    })
    .eq('id', conversation_id);

  return NextResponse.json({
    message_id: message?.id,
    channel_message_id: result.channel_message_id,
    status: result.status,
  });
}
