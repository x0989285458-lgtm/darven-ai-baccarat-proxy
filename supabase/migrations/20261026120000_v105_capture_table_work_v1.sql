begin;
-- Explicit consumer opt-in only. Original envelope, hash, raw ACK remain unchanged.
alter table public.v105_capture_settlement_outbox add column if not exists work_mode text not null default 'legacy';
create table public.v105_capture_table_work_v1 (
 id bigint generated always as identity primary key,
 parent_id uuid not null references public.v105_capture_settlement_outbox(id),
 session_id text not null, sequence bigint not null, table_id text not null,
 payload jsonb not null, status text not null default 'pending' check(status in ('pending','processing','error','completed','blocked')),
 attempts integer not null default 0, claim_token uuid, locked_at timestamptz,
 next_attempt_at timestamptz, last_error text,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(parent_id,table_id), check ((status='processing')=(claim_token is not null))
);
alter table public.v105_capture_table_work_v1 enable row level security;
create index v105_capture_table_work_v1_ready on public.v105_capture_table_work_v1(table_id,status,id);

create function public.guard_v105_capture_table_parent_v1() returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin
 if old.work_mode='table-lanes-v1' then
  if tg_op='DELETE' then raise exception 'table work parent cannot be deleted'; end if;
  if (new.id,new.session_id,new.sequence,new.payload,new.payload_hash,new.round_keys,new.work_mode)
     is distinct from (old.id,old.session_id,old.sequence,old.payload,old.payload_hash,old.round_keys,old.work_mode) then
   raise exception 'table work parent identity immutable';
  end if;
  if new.status is distinct from old.status or new.claim_token is distinct from old.claim_token or new.attempts is distinct from old.attempts then
   if new.status <> 'completed' or new.claim_token is not null
      or not exists(select 1 from public.v105_capture_table_work_v1 c where c.parent_id=old.id)
      or exists(select 1 from public.v105_capture_table_work_v1 c where c.parent_id=old.id and c.status<>'completed') then
    raise exception 'unfinished table work cannot be bypassed by legacy RPC';
   end if;
  end if;
 end if;
 if tg_op='DELETE' then return old; end if;
 return new;
end $$;
create trigger guard_v105_capture_table_parent_v1 before update or delete on public.v105_capture_settlement_outbox
 for each row execute function public.guard_v105_capture_table_parent_v1();

create function public.claim_v105_capture_table_work_v1(p_limit integer default 1)
returns setof public.v105_capture_table_work_v1 language plpgsql security definer set search_path=pg_catalog,public as $$
declare parent_row record; w jsonb; t text; unknown_work boolean; ts jsonb; rs jsonb;
begin
 if p_limit is null or p_limit<1 or p_limit>100 then raise exception 'table work limit must be 1..100'; end if;
 -- Shared claim/ACK lock prevents stale snapshots and parent-completion races.
 perform pg_advisory_xact_lock(105,261200);
 for parent_row in select * from public.v105_capture_settlement_outbox
   where work_mode='legacy' and (status in ('pending','error') or (status='processing' and locked_at < now()-interval '5 minutes'))
   order by created_at,session_id,sequence,id for update skip locked
 loop
  w := parent_row.payload->'work';
  unknown_work := w is null or jsonb_typeof(w)<>'object'
    or jsonb_typeof(w->'tables') is distinct from 'array' or jsonb_typeof(w->'rounds') is distinct from 'array';
  if not unknown_work then
   unknown_work := exists(select 1 from jsonb_object_keys(w) k where k not in ('sessionId','status','tables','rounds'))
     or exists(select 1 from jsonb_array_elements((w->'tables')||(w->'rounds')) x
     where jsonb_typeof(x)<>'object' or coalesce(x->>'tableId','') not in ('BAV01','BAV02','BAV03','BAV03A','BAV05','BAV06'));
   for t in select distinct x->>'tableId' from jsonb_array_elements((w->'tables')||(w->'rounds')) x
     where x->>'tableId' in ('BAV01','BAV02','BAV03','BAV03A','BAV05','BAV06')
   loop
    select coalesce(jsonb_agg(x),'[]') into ts from jsonb_array_elements(w->'tables') x where x->>'tableId'=t;
    select coalesce(jsonb_agg(x),'[]') into rs from jsonb_array_elements(w->'rounds') x where x->>'tableId'=t;
    insert into public.v105_capture_table_work_v1(parent_id,session_id,sequence,table_id,payload)
      values(parent_row.id,parent_row.session_id,parent_row.sequence,t,jsonb_build_object('work',w||jsonb_build_object('tables',ts,'rounds',rs)));
   end loop;
  end if;
  -- Empty known heartbeat is explicit. Unknown structures never become a successful no-op.
  if unknown_work or not exists(select 1 from public.v105_capture_table_work_v1 c where c.parent_id=parent_row.id) then
   insert into public.v105_capture_table_work_v1(parent_id,session_id,sequence,table_id,payload,status,last_error)
    values(parent_row.id,parent_row.session_id,parent_row.sequence,case when unknown_work then '__unknown__' else '__heartbeat__' end,
      parent_row.payload,case when unknown_work then 'blocked' else 'pending' end,case when unknown_work then 'unsupported work shape' else null end);
  end if;
  update public.v105_capture_settlement_outbox set work_mode='table-lanes-v1',status='error',claim_token=null,locked_at=null,
    next_attempt_at='infinity',attempts=0,isolated_at=null,updated_at=now() where id=parent_row.id;
 end loop;
 return query
 with ready as materialized (
  select c.id from public.v105_capture_table_work_v1 c
  join public.v105_capture_settlement_outbox p on p.id=c.parent_id
  where (c.status='pending' or (c.status='error' and c.next_attempt_at<=now()) or (c.status='processing' and c.locked_at<now()-interval '5 minutes'))
  and not exists(select 1 from public.v105_capture_table_work_v1 active
    where active.table_id=c.table_id and active.id<>c.id and active.status='processing' and active.locked_at>=now()-interval '5 minutes')
  and not exists (
   select 1 from public.v105_capture_table_work_v1 e join public.v105_capture_settlement_outbox ep on ep.id=e.parent_id
   where e.status<>'completed' and (e.table_id=c.table_id or e.table_id='__unknown__')
   and (case when ep.session_id=p.session_id then ep.sequence<p.sequence else (ep.created_at,ep.id)<(p.created_at,p.id) end)
  )
  -- A live legacy lease is not stolen; conservatively fence until it settles/expires.
  and not exists(select 1 from public.v105_capture_settlement_outbox l where l.work_mode='legacy' and l.status not in ('completed','dead_letter')
    and (case when l.session_id=p.session_id then l.sequence<p.sequence else (l.created_at,l.id)<(p.created_at,p.id) end)
    and (jsonb_typeof(l.payload->'work'->'tables') is distinct from 'array'
      or jsonb_typeof(l.payload->'work'->'rounds') is distinct from 'array'
      or l.payload->'work'->'tables' @> jsonb_build_array(jsonb_build_object('tableId',c.table_id))
      or l.payload->'work'->'rounds' @> jsonb_build_array(jsonb_build_object('tableId',c.table_id))))
  order by p.created_at,p.session_id,p.sequence,c.id limit p_limit
 ), claimed as (
  update public.v105_capture_table_work_v1 c set status='processing',attempts=c.attempts+1,claim_token=gen_random_uuid(),locked_at=now(),next_attempt_at=null,updated_at=now()
  from ready where c.id=ready.id returning c.*
 ) select * from claimed order by id;
end $$;

create function public.complete_v105_capture_table_work_v1(p_id bigint,p_claim_token uuid,p_attempt integer)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare pid uuid;
begin
 perform pg_advisory_xact_lock(105,261200);
 update public.v105_capture_table_work_v1 set status='completed',claim_token=null,locked_at=null,next_attempt_at=null,updated_at=now()
 where id=p_id and status='processing' and claim_token=p_claim_token and attempts=p_attempt and locked_at>=now()-interval '5 minutes'
 returning parent_id into pid;
 if pid is null then raise exception 'table work lease mismatch'; end if;
 update public.v105_capture_settlement_outbox p set status='completed',processed_at=now(),next_attempt_at=null,last_error=null,updated_at=now()
 where p.id=pid and not exists(select 1 from public.v105_capture_table_work_v1 c where c.parent_id=pid and c.status<>'completed');
 return jsonb_build_object('ok',true,'id',p_id::text);
end $$;
create function public.fail_v105_capture_table_work_v1(p_id bigint,p_claim_token uuid,p_attempt integer,p_error text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 perform pg_advisory_xact_lock(105,261200);
 update public.v105_capture_table_work_v1 set status='error',claim_token=null,locked_at=null,next_attempt_at=now()+interval '1 second',last_error=left(p_error,2000),updated_at=now()
 where id=p_id and status='processing' and claim_token=p_claim_token and attempts=p_attempt and locked_at>=now()-interval '5 minutes';
 if not found then raise exception 'table work lease mismatch'; end if;
 return jsonb_build_object('ok',true,'id',p_id::text);
end $$;
create function public.get_v105_capture_table_work_health_v1() returns jsonb language sql security definer set search_path=pg_catalog,public as $$
 select jsonb_build_object('mode','table-lanes-v1','pending',count(*) filter(where status='pending'),'processing',count(*) filter(where status='processing'),
 'error',count(*) filter(where status='error'),'completed',count(*) filter(where status='completed'),'blocked',count(*) filter(where status='blocked'),'dead_letter',0,
 'parents_pending',(select count(*) from public.v105_capture_settlement_outbox where status<>'completed'),
 'next_wakeup_at',(select min(case when c.status='pending' then now()+interval '1 second' when c.status='error' then greatest(c.next_attempt_at,now()+interval '1 second') when c.status='processing' then greatest(c.locked_at+interval '5 minutes',now()+interval '1 second') end)
 from public.v105_capture_table_work_v1 c join public.v105_capture_settlement_outbox p on p.id=c.parent_id
 where c.status in ('pending','error','processing')
 and not exists(select 1 from public.v105_capture_table_work_v1 e join public.v105_capture_settlement_outbox ep on ep.id=e.parent_id
   where e.status<>'completed' and (e.table_id=c.table_id or e.table_id='__unknown__')
   and (case when ep.session_id=p.session_id then ep.sequence<p.sequence else (ep.created_at,ep.id)<(p.created_at,p.id) end))
 and not exists(select 1 from public.v105_capture_settlement_outbox l where l.work_mode='legacy' and l.status not in ('completed','dead_letter')
   and (case when l.session_id=p.session_id then l.sequence<p.sequence else (l.created_at,l.id)<(p.created_at,p.id) end)
   and (jsonb_typeof(l.payload->'work'->'tables') is distinct from 'array' or jsonb_typeof(l.payload->'work'->'rounds') is distinct from 'array'
    or l.payload->'work'->'tables' @> jsonb_build_array(jsonb_build_object('tableId',c.table_id))
    or l.payload->'work'->'rounds' @> jsonb_build_array(jsonb_build_object('tableId',c.table_id))))))
 from public.v105_capture_table_work_v1;
$$;
revoke all on public.v105_capture_table_work_v1 from public,anon,authenticated,service_role;
revoke all on function public.claim_v105_capture_table_work_v1(integer), public.complete_v105_capture_table_work_v1(bigint,uuid,integer), public.fail_v105_capture_table_work_v1(bigint,uuid,integer,text), public.get_v105_capture_table_work_health_v1(), public.guard_v105_capture_table_parent_v1() from public,anon,authenticated;
grant execute on function public.claim_v105_capture_table_work_v1(integer), public.complete_v105_capture_table_work_v1(bigint,uuid,integer), public.fail_v105_capture_table_work_v1(bigint,uuid,integer,text), public.get_v105_capture_table_work_health_v1() to service_role;
commit;
