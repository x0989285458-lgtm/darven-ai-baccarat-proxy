"""Pure offline compiler. No connections, database drivers, or execution options."""
import argparse
import hashlib
import json
from pathlib import Path
import re
from datetime import datetime, timezone
import uuid

VERSION = 'six-raw-outbox-v1'
TABLE = 'public.v105_capture_settlement_outbox'
BAG = {'BAG01','BAG02','BAG03','BAG03A','BAG05','BAG06','BAG07','BAG08','BAG09','BAG10'}
COLUMNS = set('id session_id sequence round_keys payload payload_hash status attempts lease_generation claim_token locked_at next_attempt_at processed_at isolated_at last_error created_at updated_at'.split())
MAX_AGE = 900

def sha(text):
    return hashlib.sha256(text.encode('utf-8')).hexdigest()

def require(ok, code):
    if not ok:
        raise ValueError(code)

def pairs(items):
    result = {}
    for key, value in items:
        require(key not in result, 'DUPLICATE_JSON_KEY')
        result[key] = value
    return result

def loads(text):
    return json.loads(text, object_pairs_hook=pairs,
                      parse_constant=lambda _: (_ for _ in ()).throw(ValueError('NONFINITE_JSON')))

def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)

def digest(value):
    require(isinstance(value,str) and re.fullmatch('[0-9a-f]{64}',value), 'HASH_FORMAT')

def exact_uuid(value):
    require(isinstance(value,str) and str(uuid.UUID(value)) == value, 'UUID_FORMAT')

def validate(freeze, expected_identity, now=None):
    require(isinstance(freeze,dict) and set(freeze)=={'version','scope','exported_at','identity','catalog_text','catalog_sha256','non_target_sha256','rows'}, 'FREEZE_FIELDS')
    require(freeze['version']==VERSION and freeze['scope']==TABLE, 'SCOPE')
    identity=freeze['identity']
    require(isinstance(identity,dict) and set(identity)=={'database','database_oid','system_identifier','server_address','server_port','role','role_oid','server_version'}, 'IDENTITY_FIELDS')
    require(identity==expected_identity and all(v is not None and v!='' for v in identity.values()), 'IDENTITY')
    require(type(identity['server_port']) is int and 1<=identity['server_port']<=65535, 'PORT')
    for name in ('database_oid','role_oid','system_identifier','server_version'):
        require(isinstance(identity[name],str) and re.fullmatch('[0-9]+',identity[name]), 'IDENTITY_NUMBER')
    stamp=datetime.fromisoformat(freeze['exported_at'])
    require(stamp.tzinfo is not None, 'TIMEZONE')
    age=((now or datetime.now(timezone.utc))-stamp).total_seconds()
    require(0<=age<=MAX_AGE, 'STALE_SNAPSHOT')
    digest(freeze['catalog_sha256'])
    require(sha(freeze['catalog_text'])==freeze['catalog_sha256'], 'CATALOG_HASH')
    catalog=loads(freeze['catalog_text'])
    require(catalog.get('supported') is True and catalog.get('owner')==identity['role_oid'], 'UNSUPPORTED_CATALOG_OR_OWNER')
    require(isinstance(freeze['rows'],list) and freeze['rows'], 'EMPTY_INVENTORY')
    ids=set(); targets=[]; non=[]
    for row in freeze['rows']:
        require(isinstance(row,dict) and set(row)=={'id','before_text','before_sha256','after_text','after_sha256'}, 'ROW_FIELDS')
        exact_uuid(row['id']); require(row['id'] not in ids,'DUPLICATE_UUID'); ids.add(row['id'])
        for side in ('before','after'):
            digest(row[side+'_sha256'])
            require(sha(row[side+'_text'])==row[side+'_sha256'], 'ROW_HASH')
        before=loads(row['before_text']); after=loads(row['after_text'])
        require(isinstance(before,dict) and set(before)==COLUMNS and before['id']==row['id'], 'ROW_SCHEMA_OR_ID')
        require(before['status'] in ('pending','completed','dead_letter') and before['claim_token'] is None, 'ACTIVE_OR_UNKNOWN_WORK')
        if before['status']=='pending':
            keys=before['round_keys']; payload=before['payload']
            require(isinstance(keys,list) and keys and len(keys)==len(set(keys)), 'ROUND_KEYS')
            for key in keys:
                require(isinstance(key,str) and re.fullmatch(r'BAG(?:01|02|03|03A|05|06|07|08|09|10):[0-9]+:[0-9]+',key), 'NON_BAG_KEY')
            require(isinstance(payload,dict) and payload.get('round_keys')==keys, 'PAYLOAD_KEYS')
            rounds=payload.get('rounds')
            require(isinstance(rounds,list) and len(rounds)==len(keys), 'PAYLOAD_ROUNDS')
            for key, r in zip(keys,rounds):
                require(isinstance(r,dict) and r.get('source')=='ofalive99' and r.get('table_id') in BAG, 'ROUND_SCOPE')
                require(key==f"{r['table_id']}:{r.get('shoe_no')}:{r.get('round_no')}", 'ROUND_IDENTITY')
            def check_nested(value):
                if isinstance(value,dict):
                    for k,v in value.items():
                        require(k!='table_id' or v in BAG, 'NESTED_SCOPE')
                        check_nested(k); check_nested(v)
                elif isinstance(value,list):
                    for v in value: check_nested(v)
                elif isinstance(value,str):
                    require(not value.startswith('BAV'), 'MIXED_BAV')
            check_nested(payload)
            require(after==dict(before,status='dead_letter'), 'STATUS_ONLY_POSTIMAGE')
            targets.append(row['id'])
        else:
            require(row['after_text']==row['before_text'], 'NON_TARGET_CHANGED')
            non.append((row['id'],row['before_sha256']))
    require(targets, 'EMPTY_TARGETS')
    digest(freeze['non_target_sha256'])
    require(sha('\n'.join(i+':'+h for i,h in sorted(non)))==freeze['non_target_sha256'], 'NON_TARGET_DIGEST')
    return targets

def query(label):
    source=Path(__file__).with_name('export.sql').read_text(encoding='utf-8')
    return source.split('-- BEGIN '+label+' QUERY\n',1)[1].split('-- END '+label+' QUERY',1)[0].strip()

def sql_json(value):
    # Hex prevents quotes, backslashes, dollar delimiters, Unicode or NUL from becoming SQL.
    return "convert_from(decode('"+canonical(value).encode('utf-8').hex()+"','hex'),'UTF8')::jsonb"

def render(freeze, freeze_hash, operation, reverse=False):
    receipt='public.six_hold_'+operation.replace('-','')
    before='after' if reverse else 'before'; after='before' if reverse else 'after'
    status='pending' if reverse else 'dead_letter'
    header=f"""-- OFFLINE CANDIDATE ONLY. SQL execution NOT VERIFIED. operation={operation}
BEGIN;
SET LOCAL TIME ZONE 'UTC';
SET LOCAL search_path=pg_catalog;
SET LOCAL row_security=off;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
SET LOCAL idle_in_transaction_session_timeout='60s';
LOCK TABLE {TABLE} IN SHARE ROW EXCLUSIVE MODE;
"""
    if reverse:
        header+=f'LOCK TABLE {receipt} IN SHARE ROW EXCLUSIVE MODE;\n'
    freshness = "" if reverse else """ IF clock_timestamp() < (j->>'exported_at')::timestamptz OR
    clock_timestamp() > (j->>'exported_at')::timestamptz + interval '15 minutes' THEN
  RAISE EXCEPTION 'STALE_SNAPSHOT'; END IF;
"""
    common=f"""DO $packet$
DECLARE j jsonb := {sql_json(freeze)}; n bigint;
BEGIN
 IF current_setting('hermes.six_cutover_quiesced',true) IS DISTINCT FROM 'yes' THEN
  RAISE EXCEPTION 'QUIESCENCE_DECLARATION_REQUIRED'; END IF;
 IF (SELECT value FROM ({query('IDENTITY')}) identity_check) IS DISTINCT FROM j->'identity' THEN
  RAISE EXCEPTION 'WRONG_DATABASE_IDENTITY'; END IF;
{freshness}
 IF (SELECT value::text FROM ({query('CATALOG')}) catalog_check) IS DISTINCT FROM j->>'catalog_text' THEN
  RAISE EXCEPTION 'CATALOG_DRIFT'; END IF;
 IF (SELECT count(*) FROM {TABLE}) <> jsonb_array_length(j->'rows') THEN
  RAISE EXCEPTION 'INVENTORY_COUNT'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(j->'rows') e
   LEFT JOIN {TABLE} o ON o.id=(e->>'id')::uuid
   WHERE o.id IS NULL OR to_jsonb(o)::text IS DISTINCT FROM e->>'{before}_text'
   OR encode(sha256(convert_to(to_jsonb(o)::text,'UTF8')),'hex') IS DISTINCT FROM e->>'{before}_sha256') THEN
  RAISE EXCEPTION 'EXACT_INVENTORY_PREIMAGE'; END IF;
 IF EXISTS(SELECT 1 FROM {TABLE} WHERE status IN ({"'pending','processing','error'" if reverse else "'processing','error'"})) THEN
  RAISE EXCEPTION 'ACTIVE_WORK'; END IF;
"""
    acl=f"""
 IF EXISTS(SELECT 1 FROM pg_class c CROSS JOIN LATERAL
    aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
    WHERE c.oid='{receipt}'::regclass AND a.grantee<>c.relowner)
 OR EXISTS(SELECT 1 FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) p
    WHERE a.attrelid='{receipt}'::regclass AND p.grantee<>(SELECT relowner FROM pg_class WHERE oid=a.attrelid))
 OR NOT EXISTS(SELECT 1 FROM pg_class WHERE oid='{receipt}'::regclass AND relkind='r'
    AND relowner=current_user::regrole::oid AND relrowsecurity AND NOT relispartition)
 OR EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='{receipt}'::regclass)
 OR EXISTS(SELECT 1 FROM pg_rewrite WHERE ev_class='{receipt}'::regclass)
 OR EXISTS(SELECT 1 FROM pg_inherits WHERE inhrelid='{receipt}'::regclass OR inhparent='{receipt}'::regclass)
 OR EXISTS(SELECT 1 FROM pg_policy WHERE polrelid='{receipt}'::regclass) THEN
  RAISE EXCEPTION 'RECEIPT_NOT_PRIVATE_PLAIN_OWNER_TABLE'; END IF;
"""
    if not reverse:
        common+=f"""
 CREATE TABLE {receipt} (id uuid PRIMARY KEY, operation_id uuid NOT NULL, freeze_sha256 text NOT NULL,
   before_text text NOT NULL, before_sha256 text NOT NULL, after_text text NOT NULL, after_sha256 text NOT NULL,
   reversed boolean NOT NULL DEFAULT false);
 ALTER TABLE {receipt} ENABLE ROW LEVEL SECURITY;
 REVOKE ALL ON TABLE {receipt} FROM PUBLIC, anon, authenticated, service_role;
"""+acl+f"""
 INSERT INTO {receipt}(id,operation_id,freeze_sha256,before_text,before_sha256,after_text,after_sha256)
 SELECT (e->>'id')::uuid,'{operation}','{freeze_hash}',e->>'before_text',e->>'before_sha256',e->>'after_text',e->>'after_sha256'
 FROM jsonb_array_elements(j->'rows') e WHERE (e->>'before_text')::jsonb->>'status'='pending';
"""
    else:
        common+=acl+f"""
 IF (SELECT count(*) FROM {receipt}) <> (SELECT count(*) FROM jsonb_array_elements(j->'rows') e WHERE (e->>'before_text')::jsonb->>'status'='pending')
 OR EXISTS(SELECT 1 FROM {receipt} r LEFT JOIN jsonb_array_elements(j->'rows') e ON r.id=(e->>'id')::uuid
   WHERE e IS NULL OR (e->>'before_text')::jsonb->>'status' IS DISTINCT FROM 'pending'
   OR r.operation_id IS DISTINCT FROM '{operation}'::uuid OR r.freeze_sha256 IS DISTINCT FROM '{freeze_hash}'
   OR r.reversed IS DISTINCT FROM false OR r.before_text IS DISTINCT FROM e->>'before_text'
   OR r.after_text IS DISTINCT FROM e->>'after_text' OR r.before_sha256 IS DISTINCT FROM e->>'before_sha256'
   OR r.after_sha256 IS DISTINCT FROM e->>'after_sha256') THEN RAISE EXCEPTION 'RECEIPT_PROOF'; END IF;
"""
    common+=f"""
 UPDATE {TABLE} o SET status='{status}' FROM {receipt} r WHERE o.id=r.id;
 GET DIAGNOSTICS n=ROW_COUNT;
 IF n<>(SELECT count(*) FROM {receipt}) THEN RAISE EXCEPTION 'AFFECTED_COUNT'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(j->'rows') e LEFT JOIN {TABLE} o ON o.id=(e->>'id')::uuid
  WHERE o.id IS NULL OR to_jsonb(o)::text IS DISTINCT FROM e->>'{after}_text'
  OR encode(sha256(convert_to(to_jsonb(o)::text,'UTF8')),'hex') IS DISTINCT FROM e->>'{after}_sha256')
 OR (SELECT count(*) FROM {TABLE})<>jsonb_array_length(j->'rows') THEN RAISE EXCEPTION 'EXACT_POSTIMAGE'; END IF;
"""
    if reverse:
        common+=f' UPDATE {receipt} SET reversed=true;\n'
    return header+common+f"END $packet$;\nSELECT * FROM {receipt} ORDER BY id;\nROLLBACK;\n"

def build_packet(input_path, expected_identity_path, output_path):
    raw=Path(input_path).read_bytes()
    freeze=loads(raw.decode('utf-8'))
    targets=validate(freeze,loads(Path(expected_identity_path).read_text(encoding='utf-8')))
    freeze_hash=hashlib.sha256(raw).hexdigest()
    # Same exact freeze produces same operation/receipt: cannot silently replay under a new name.
    operation=str(uuid.uuid5(uuid.NAMESPACE_URL, VERSION+':'+freeze_hash))
    files={'freeze.json':raw,'hold.sql':render(freeze,freeze_hash,operation).encode('utf-8'),
           'reverse.sql':render(freeze,freeze_hash,operation,True).encode('utf-8')}
    manifest={'version':VERSION,'operation_id':operation,'target_count':len(targets),'inventory_count':len(freeze['rows']),
              'identity':freeze['identity'],'terminal':'ROLLBACK','evidence_class':'OFFLINE_COMPILER_ONLY',
              'files':{name:hashlib.sha256(data).hexdigest() for name,data in files.items()},
              'source_files':{name:hashlib.sha256(Path(__file__).with_name(name).read_bytes()).hexdigest() for name in ('build_packet.py','export.sql')}}
    out=Path(output_path)
    require(not out.is_symlink(), 'OUTPUT_SYMLINK')
    for parent in out.absolute().parents:
        require(not parent.is_symlink() and not parent.is_junction(), 'OUTPUT_LINK_ANCESTOR')
    out.mkdir(exist_ok=False)
    # Any partial write remains forensic evidence; never overwrite or auto-clean/retry.
    for name,data in files.items():
        with (out/name).open('xb') as handle: handle.write(data)
    with (out/'manifest.json').open('x',encoding='utf-8',newline='\n') as handle:
        json.dump(manifest,handle,ensure_ascii=False,indent=2); handle.write('\n')
    return manifest

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--freeze',required=True)
    parser.add_argument('--expected-identity',required=True)
    parser.add_argument('--output',required=True)
    args=parser.parse_args()
    try:
        result=build_packet(args.freeze,args.expected_identity,args.output)
    except (ValueError,TypeError,KeyError,OSError) as exc:
        parser.exit(2,'BLOCK: '+type(exc).__name__+'\n')
    print(json.dumps(result,ensure_ascii=False,indent=2))

if __name__=='__main__':
    main()
