-- Draven AI Baccarat v091 DB 儲存精簡化相容欄位
-- 用途：保留真牌碼/牌面剩餘與可重算資訊，同時讓 daily_roadmap_events 不重複存路單原文。
-- 安全：請在 Supabase SQL Editor 或後端受控環境執行；不要把 service role key 寫進前端。

begin;

alter table public.daily_roadmap_events
  add column if not exists player_card_ranks jsonb not null default '[]'::jsonb,
  add column if not exists banker_card_ranks jsonb not null default '[]'::jsonb,
  add column if not exists player_card_faces jsonb not null default '[]'::jsonb,
  add column if not exists banker_card_faces jsonb not null default '[]'::jsonb,
  add column if not exists remaining_rank_counts jsonb not null default '{}'::jsonb;

create index if not exists daily_roadmap_events_remaining_rank_counts_gin_idx
  on public.daily_roadmap_events using gin (remaining_rank_counts);

comment on column public.daily_roadmap_events.road_features is
  'v091 起不再由 live writer 重複寫入路單原文；路單原文保留在 cloud_table_snapshots/tables 來源，這欄僅供舊資料相容。';

comment on column public.daily_roadmap_events.remaining_rank_counts is
  'v091 保留 A-K 剩餘牌面張數，供副預測/回測臨時檔重算；不存重複路單原文。';

commit;