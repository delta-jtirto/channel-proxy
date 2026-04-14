import { NextResponse, type NextRequest } from 'next/server';
import { authenticateRequest, getUserCompanyIds } from '@/lib/auth/middleware';
import { getServiceClient } from '@/lib/db/supabase';
import { decryptCredentials } from '@/lib/credentials';
import { registry } from '@/lib/adapters/registry';
import type { Channel } from '@/lib/adapters/types';

// Import all adapters to register them
import '@/lib/adapters/whatsapp';
import '@/lib/adapters/instagram';
import '@/lib/adapters/line';
import '@/lib/adapters/email/gmail';

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
  const { conversation_id, text, content_type, attachments } = body;

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
      id, company_id, channel, account_id,
      contacts!inner (id, channel_contact_id, display_name)
    `)
    .eq('id', conversation_id)
    .single();

  if (!convo) {
    return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
  }

  // Verify user access
  const userCompanies = await getUserCompanyIds(auth.user.id);
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

  const contact = convo.contacts as unknown as {
    id: string;
    channel_contact_id: string;
    display_name: string;
  };

  const result = await adapter.send(
    creds,
    { conversation_id, text, content_type, attachments },
    contact.channel_contact_id,
  );

  if (result.status === 'failed') {
    return NextResponse.json(
      { error: result.error_message ?? 'Send failed' },
      { status: 502 },
    );
  }

  // Store the outbound message
  const now = new Date().toISOString();
  const { data: message, error: insertError } = await supabase
    .from('messages')
    .insert({
      conversation_id,
      company_id: convo.company_id,
      channel: convo.channel,
      direction: 'outbound',
      sender_id: `company:${auth.user.id}`,
      sender_name: auth.user.email,
      content_type: content_type ?? 'text',
      text_body: text,
      attachments: attachments ?? [],
      channel_message_id: result.channel_message_id,
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

  // Update conversation last message
  await supabase
    .from('conversations')
    .update({
      last_message_at: now,
      last_message_preview: text.slice(0, 200),
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
