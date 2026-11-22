-- migrate:up
CREATE FUNCTION semantic.erasure_original_role_position(p_home integer, p_tx uuid) RETURNS bigint
    LANGUAGE plpgsql STABLE STRICT
    AS $$
DECLARE original_position bigint;
BEGIN
 SELECT coalesce(
   (SELECT position FROM editorial.write_basis WHERE partition_no=p_home AND transaction_id=p_tx),
   (SELECT position FROM semantic.erasure_source_commit WHERE partition_no=p_home AND transaction_id=p_tx),
   (SELECT position FROM semantic.identity_epoch_native_commit WHERE partition_no=p_home AND transaction_id=p_tx)
 ) INTO original_position;
 IF original_position IS NULL THEN
  RAISE EXCEPTION 'Semantic erased Source role lacks its original transaction position' USING ERRCODE='23514';
 END IF;
 RETURN original_position;
END; $$;

-- Keep the native delivery and each inherited transaction independently addressed.
DO $migration$ BEGIN
 EXECUTE replace(pg_get_functiondef('semantic.capture_erasure_roles(integer,text,bigint,uuid)'::regprocedure),
   $from$p_key,source_tx,native_position);$from$,
   $to$p_key,source_tx,CASE WHEN source_tx=native_tx THEN native_position ELSE semantic.erasure_original_role_position(p_home,source_tx) END);$to$);
 EXECUTE replace(replace(replace(pg_get_functiondef('semantic.capture_erasure_roles_unfunded(integer,text,bigint,uuid)'::regprocedure),
   $from$DECLARE b editorial.write_basis; provenance_key bigint; r record; native_position bigint; acting_human uuid;$from$,
   $to$DECLARE b editorial.write_basis; provenance_key bigint; r record; native_position bigint; acting_human uuid;
 native_tx uuid:=nullif(current_setting('semantic.erasure_native_transaction',true),'')::uuid;$to$),
   $from$p_key,p_tx,native_position);$from$,
   $to$p_key,p_tx,CASE WHEN p_tx=native_tx THEN native_position ELSE semantic.erasure_original_role_position(p_home,p_tx) END);$to$),
   $from$p_key,r.transaction_id,native_position);$from$,
   $to$p_key,r.transaction_id,CASE WHEN r.transaction_id=native_tx THEN native_position ELSE semantic.erasure_original_role_position(p_home,r.transaction_id) END);$to$);
END; $migration$;

-- migrate:down
DO $migration$ BEGIN
 EXECUTE replace(pg_get_functiondef('semantic.capture_erasure_roles(integer,text,bigint,uuid)'::regprocedure),
   $from$p_key,source_tx,CASE WHEN source_tx=native_tx THEN native_position ELSE semantic.erasure_original_role_position(p_home,source_tx) END);$from$,
   $to$p_key,source_tx,native_position);$to$);
 EXECUTE replace(replace(replace(pg_get_functiondef('semantic.capture_erasure_roles_unfunded(integer,text,bigint,uuid)'::regprocedure),
   $from$DECLARE b editorial.write_basis; provenance_key bigint; r record; native_position bigint; acting_human uuid;
 native_tx uuid:=nullif(current_setting('semantic.erasure_native_transaction',true),'')::uuid;$from$,
   $to$DECLARE b editorial.write_basis; provenance_key bigint; r record; native_position bigint; acting_human uuid;$to$),
   $from$p_key,p_tx,CASE WHEN p_tx=native_tx THEN native_position ELSE semantic.erasure_original_role_position(p_home,p_tx) END);$from$,
   $to$p_key,p_tx,native_position);$to$),
   $from$p_key,r.transaction_id,CASE WHEN r.transaction_id=native_tx THEN native_position ELSE semantic.erasure_original_role_position(p_home,r.transaction_id) END);$from$,
   $to$p_key,r.transaction_id,native_position);$to$);
END; $migration$;
DROP FUNCTION semantic.erasure_original_role_position(integer,uuid);
