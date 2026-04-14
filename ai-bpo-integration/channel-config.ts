/**
 * AI BPO Integration: Channel configuration and icons.
 *
 * Add these to the existing firestore-mappers.ts in the AI BPO project,
 * or import from a new file alongside it.
 */

import { MessageSquare, Globe, Phone, Mail } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

// Extend the existing CHANNEL_ICONS with new proxy channels
export const CHANNEL_ICONS: Record<string, LucideIcon> = {
  // Legacy (Unified Inbox / Firestore)
  airbnb: MessageSquare,
  booking_com: Globe,
  'booking.com': Globe,
  // New (Channel Proxy / Supabase)
  whatsapp: Phone,          // or use a WhatsApp brand icon
  instagram: Globe,          // or use an Instagram brand icon
  line: MessageSquare,       // or use a LINE brand icon
  email: Mail,
  telegram: MessageSquare,   // future
};

export function channelToIcon(channel: string): LucideIcon {
  const key = channel.toLowerCase().replace(/\s+/g, '_');
  return CHANNEL_ICONS[key] || Phone;
}

export function channelDisplayName(channel: string): string {
  const map: Record<string, string> = {
    // Legacy
    airbnb: 'Airbnb',
    booking_com: 'Booking.com',
    'booking.com': 'Booking.com',
    // New
    whatsapp: 'WhatsApp',
    instagram: 'Instagram',
    line: 'LINE',
    email: 'Email',
    telegram: 'Telegram',
  };
  return map[channel.toLowerCase()] || channel;
}

/**
 * Extended sender role mapping for proxy channels.
 * Add 'contact' to the existing ROLE_MAP in firestore-mappers.ts.
 */
export const PROXY_ROLE_MAP: Record<string, 'guest' | 'host' | 'agent' | 'system' | 'bot'> = {
  contact: 'guest',   // External contacts map to 'guest' in BPO context
  company: 'agent',   // Company-sent messages map to 'agent'
  system: 'system',
};

/**
 * Determine the data source for a conversation based on channel.
 */
export function getConversationSource(channel: string): 'firestore' | 'supabase' {
  const proxyChannels = new Set(['whatsapp', 'instagram', 'line', 'email', 'telegram']);
  return proxyChannels.has(channel.toLowerCase()) ? 'supabase' : 'firestore';
}
