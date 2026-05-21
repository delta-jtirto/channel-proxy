-- Add delivery_target so a channel account can route inbound messages
-- to either the BPO consumer (default, existing behaviour) or the new
-- Support consumer.
--
-- Existing rows default to 'bpo' so BPO traffic is byte-identical;
-- Support accounts are created with 'support' explicitly via the
-- /api/proxy/accounts POST.

alter table channel_accounts
  add column if not exists delivery_target text not null default 'bpo'
    check (delivery_target in ('bpo','support'));

create index if not exists channel_accounts_delivery_target_idx
  on channel_accounts (delivery_target);

comment on column channel_accounts.delivery_target is
  'Which downstream consumer should receive inbound messages from this '
  'account. ''bpo'' (default) keeps the existing webhook → contacts → '
  'conversations → messages write path. ''support'' additionally forwards '
  'the normalised message to the Support edge function defined by '
  'SUPPORT_WEBHOOK_URL.';
