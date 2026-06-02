# Migrations

## Shared Supabase project

This repo (`channel-proxy`) and [`delta/AI CS BPO`](../../../AI%20CS%20BPO) point at the **same** linked Supabase project (`AI Project (BPO + TS)`). The migration history table is therefore shared, but the migration *files* are split:

- **channel-proxy** owns: integration-layer schemas (conversations, messages, contacts, channel_accounts, webhook_logs)
- **AI CS BPO** owns: app-level schemas (assist_messages, assist_drafts, knowledge_chunks, support_*, help_centers, etc.)

## Pushing migrations from this repo

Because BPO's migrations were pushed first, the remote history contains BPO migrations that don't exist as files here. `npx supabase db push` will abort with:

```
Remote migration versions not found in local migrations directory.
```

Workaround — mirror the migration into AI CS BPO and push from there:

1. Write the migration here as normal: `supabase/migrations/<timestamp>_<name>.sql`
2. Copy the file to `delta/AI CS BPO/supabase/migrations/<timestamp>_<name>.sql` and add a header comment: `Schema-owner: channel-proxy. Source of truth lives at: delta/channel-proxy/supabase/migrations/<file>.sql`
3. Push from AI CS BPO: `cd "delta/AI CS BPO" && npx supabase db push`
4. Mark the migration applied in this repo's tracking so future pushes don't trip:
   ```
   npx supabase migration repair --status applied <timestamp>
   ```

## Long-term plan

When channel-proxy's hot path warrants its own Supabase project, split the two and this README goes away. Until then, treat this as the documented bridge.
