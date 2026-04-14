/**
 * AI BPO Integration: Merged conversation list from Firestore + Supabase.
 *
 * Drop this into the AI BPO project at:
 *   src/hooks/use-merged-conversations.ts
 *
 * Merges legacy Firestore threads (Airbnb/Booking.com) with proxy
 * Supabase conversations (WhatsApp/Instagram/LINE/Email) into a
 * single sorted list.
 */

import { useMemo, useCallback } from 'react';
import type { ProxyConversation } from './use-proxy-conversations';

/**
 * Unified conversation item that can come from either source.
 */
export interface MergedConversation {
  id: string;
  source: 'firestore' | 'supabase';
  companyId: string;
  channel: string;
  contactName: string;
  contactAvatar: string | null;
  lastMessagePreview: string | null;
  lastMessageAt: number; // epoch ms for sorting
  unreadCount: number;
  subject: string | null; // email subject
  // Original data for detail view
  firestoreThread?: unknown;
  proxyConversation?: ProxyConversation;
}

interface FirestoreThread {
  thread_id: string;
  channel: string;
  guest_name?: string;
  guest_avatar_url?: string;
  last_message_preview?: string;
  last_message_at?: number;
  unread_count?: number;
  booking_id?: number;
}

interface UseMergedConversationsOptions {
  firestoreThreads: FirestoreThread[];
  firestoreLoading: boolean;
  firestoreLoadMore: () => void;
  proxyConversations: ProxyConversation[];
  proxyLoading: boolean;
  proxyLoadMore: () => void;
}

export function useMergedConversations({
  firestoreThreads,
  firestoreLoading,
  firestoreLoadMore,
  proxyConversations,
  proxyLoading,
  proxyLoadMore,
}: UseMergedConversationsOptions) {
  const merged = useMemo(() => {
    const items: MergedConversation[] = [];

    // Map Firestore threads
    for (const t of firestoreThreads) {
      const ts = t.last_message_at ?? 0;
      items.push({
        id: t.thread_id,
        source: 'firestore',
        companyId: '', // from host context
        channel: t.channel,
        contactName: t.guest_name ?? 'Unknown',
        contactAvatar: t.guest_avatar_url ?? null,
        lastMessagePreview: t.last_message_preview ?? null,
        lastMessageAt: ts > 1e12 ? ts : ts * 1000,
        unreadCount: t.unread_count ?? 0,
        subject: null,
        firestoreThread: t,
      });
    }

    // Map Supabase proxy conversations
    for (const c of proxyConversations) {
      const contact = c.contacts as unknown as {
        display_name: string | null;
        avatar_url: string | null;
      };
      items.push({
        id: c.id,
        source: 'supabase',
        companyId: c.company_id,
        channel: c.channel,
        contactName: contact?.display_name ?? 'Unknown',
        contactAvatar: contact?.avatar_url ?? null,
        lastMessagePreview: c.last_message_preview,
        lastMessageAt: new Date(c.last_message_at).getTime(),
        unreadCount: c.unread_count,
        subject: c.subject,
        proxyConversation: c,
      });
    }

    // Sort by most recent message first
    items.sort((a, b) => b.lastMessageAt - a.lastMessageAt);

    return items;
  }, [firestoreThreads, proxyConversations]);

  const loadMore = useCallback(() => {
    if (merged.length === 0) {
      firestoreLoadMore();
      proxyLoadMore();
      return;
    }

    // Determine which source needs more data
    const lastFirestore = firestoreThreads.at(-1);
    const lastProxy = proxyConversations.at(-1);

    const lastFirestoreTs = lastFirestore?.last_message_at
      ? (lastFirestore.last_message_at > 1e12
          ? lastFirestore.last_message_at
          : lastFirestore.last_message_at * 1000)
      : 0;
    const lastProxyTs = lastProxy?.last_message_at
      ? new Date(lastProxy.last_message_at).getTime()
      : 0;

    // Load more from whichever source has newer unseen items
    if (lastFirestoreTs > lastProxyTs) {
      firestoreLoadMore();
    } else {
      proxyLoadMore();
    }
  }, [
    merged,
    firestoreThreads,
    proxyConversations,
    firestoreLoadMore,
    proxyLoadMore,
  ]);

  return {
    conversations: merged,
    isLoading: firestoreLoading || proxyLoading,
    loadMore,
  };
}
