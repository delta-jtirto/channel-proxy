/**
 * Cross-path email idempotency.
 *
 * The same inbound email can be ingested by more than one path (Gmail API push
 * + IMAP poll) when a mailbox is connected twice. Each path historically keyed
 * idempotency differently (`email_gmail_<gmailId>` vs `email_imap_<messageId>`),
 * so the global UNIQUE on messages.idempotency_key never caught the cross-path
 * duplicate and the guest's thread showed the message twice (reported
 * 2026-06-22 — same email landed in two conversations ~90s apart).
 *
 * Key both paths on the normalized RFC822 Message-ID header — stable across
 * Gmail API and IMAP for the same email — so the second ingestion dedups via
 * the UNIQUE constraint. Falls back to a path-specific id only when the email
 * carries no Message-ID header.
 *
 * NOTE: this dedups the message ROW, not the conversation. When a mailbox is
 * connected twice the second path still upserts its own conversation before the
 * message dedups, leaving a possible empty thread — the real fix is one mailbox
 * = one channel account (operational, or enforce at link time).
 */
export function normalizeEmailMessageId(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw.trim().replace(/^<+|>+$/g, '').trim().toLowerCase();
}

export function emailIdempotencyKey(
  messageIdHeader: string | null | undefined,
  fallbackId: string,
): string {
  const norm = normalizeEmailMessageId(messageIdHeader);
  return norm ? `email_msg_${norm}` : `email_fallback_${fallbackId}`;
}
