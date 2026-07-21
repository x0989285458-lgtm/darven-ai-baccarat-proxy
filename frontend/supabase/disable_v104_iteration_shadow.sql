begin;
update public.v104_iteration_shadow_runtime_settings
set enabled=false,status='shadow_disabled',updated_at=now()
where release_candidate='v104.1.0-seven-head-shadow.1';
commit;
