-- Formal.19 gives every strategy activation an immutable generation UUID.
-- Rollback receipts must carry the exact active v106 generation; historical
-- receipts with unrelated nonces can never authorize a later activation.
begin;

alter table public.ai_strategy_versions
  add column if not exists cutover_generation uuid;

update public.ai_strategy_versions
set cutover_generation = gen_random_uuid()
where cutover_generation is null;

alter table public.ai_strategy_versions
  alter column cutover_generation set default gen_random_uuid(),
  alter column cutover_generation set not null;

create unique index if not exists ai_strategy_versions_cutover_generation_idx
  on public.ai_strategy_versions (cutover_generation);

commit;
