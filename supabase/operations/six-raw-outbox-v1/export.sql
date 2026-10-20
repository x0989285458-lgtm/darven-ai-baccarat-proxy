-- PREPARATION ONLY. Do not execute without a separately authorized fresh export.
-- Save the single JSON text value verbatim as UTF-8. No psql formatting/header.
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL TIME ZONE 'UTC';
SET LOCAL search_path = pg_catalog;
SET LOCAL row_security = off;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';
SET LOCAL idle_in_transaction_session_timeout = '60s';
WITH identity AS (
-- BEGIN IDENTITY QUERY
SELECT jsonb_build_object(
 'database',current_database(), 'database_oid',(SELECT oid::text FROM pg_database WHERE datname=current_database()),
 'system_identifier',(SELECT system_identifier::text FROM pg_control_system()),
 'server_address',inet_server_addr()::text, 'server_port',inet_server_port(),
 'role',current_user, 'role_oid',(SELECT oid::text FROM pg_roles WHERE rolname=current_user),
 'server_version',current_setting('server_version_num')) AS value
-- END IDENTITY QUERY
), catalog AS (
-- BEGIN CATALOG QUERY
SELECT jsonb_build_object(
 'supported',c.relkind='r' AND NOT c.relispartition
   AND NOT EXISTS(SELECT 1 FROM pg_inherits WHERE inhrelid=c.oid OR inhparent=c.oid)
   AND NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=c.oid)
   AND NOT EXISTS(SELECT 1 FROM pg_rewrite WHERE ev_class=c.oid),
 'owner',c.relowner::text,
 'relation',jsonb_build_object('oid',c.oid::text,'kind',c.relkind,'owner',c.relowner::text,
   'acl',c.relacl,'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'options',c.reloptions),
 'columns',(SELECT jsonb_agg(to_jsonb(a) ORDER BY attnum) FROM pg_attribute a WHERE attrelid=c.oid AND attnum>0),
 'constraints',(SELECT jsonb_agg(jsonb_build_object('row',to_jsonb(x),'def',pg_get_constraintdef(x.oid)) ORDER BY x.oid) FROM pg_constraint x WHERE conrelid=c.oid),
 'indexes',(SELECT jsonb_agg(jsonb_build_object('row',to_jsonb(x),'def',pg_get_indexdef(x.indexrelid)) ORDER BY indexrelid) FROM pg_index x WHERE indrelid=c.oid),
 'policies',(SELECT jsonb_agg(to_jsonb(x) ORDER BY oid) FROM pg_policy x WHERE polrelid=c.oid),
 'functions',(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public')
) AS value FROM pg_class c WHERE c.oid='public.v105_capture_settlement_outbox'::regclass
-- END CATALOG QUERY
), images AS (
 SELECT id, status, to_jsonb(o)::text AS before_text,
   (to_jsonb(o)||jsonb_build_object('status','dead_letter'))::text AS after_text
 FROM public.v105_capture_settlement_outbox o
), rows AS (
 SELECT *,encode(sha256(convert_to(before_text,'UTF8')),'hex') AS before_sha256,
 encode(sha256(convert_to(after_text,'UTF8')),'hex') AS after_sha256 FROM images
)
SELECT jsonb_build_object(
 'version','six-raw-outbox-v1', 'scope','public.v105_capture_settlement_outbox',
 'exported_at',transaction_timestamp(), 'identity',(SELECT value FROM identity),
 'catalog_text',(SELECT value::text FROM catalog),
 'catalog_sha256',(SELECT encode(sha256(convert_to(value::text,'UTF8')),'hex') FROM catalog),
 'non_target_sha256',encode(sha256(convert_to(coalesce((SELECT string_agg(id::text||':'||before_sha256,E'\n' ORDER BY id) FROM rows WHERE status<>'pending'),''),'UTF8')),'hex'),
 'rows',coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'before_text',before_text,'before_sha256',before_sha256,
   'after_text',CASE WHEN status='pending' THEN after_text ELSE before_text END,
   'after_sha256',CASE WHEN status='pending' THEN after_sha256 ELSE before_sha256 END) ORDER BY id) FROM rows),'[]'::jsonb)
)::text;
ROLLBACK;
