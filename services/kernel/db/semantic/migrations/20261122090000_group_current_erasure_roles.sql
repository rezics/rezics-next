-- migrate:up
-- A direct account can own both the native record and its immutable write basis.
-- Read their common delivery, coverage and roles once. Foreign or delegated input
-- retains the per-origin capture, including link projection and sealed replay.
CREATE FUNCTION semantic.capture_current_erasure_roles(
  p_home integer, p_store text, p_key bigint, p_tx uuid
) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE
  actor uuid;
  native_position bigint;
  roles text[];
  same_account boolean;
  provenance_key bigint;
BEGIN
  IF p_tx IS NULL OR p_store IN ('write_basis', 'outbound_link', 'inbound_link')
     OR nullif(current_setting('semantic.erasure_native_transaction', true), '')::uuid IS DISTINCT FROM p_tx THEN
    RETURN false;
  END IF;

  SELECT b.principal_id, p.position INTO actor, native_position
  FROM core.partition p JOIN editorial.write_basis b ON b.partition_no=p.partition_no AND b.transaction_id=p_tx
  WHERE p.partition_no=p_home AND b.principal_kind='account' AND b.position=p.position
    AND b.principal_id NOT IN ('00000000-0000-0000-0000-000000000000', '00000000-0000-8000-8000-000000000001')
    AND (b.requested_by IS NULL OR b.requested_by !~ '^urn:rezics:request:[0-9a-f-]{36}:[0-9a-f-]{36}$')
    AND NOT EXISTS (SELECT FROM semantic.erasure_source_seal s WHERE s.partition_no=p_home AND s.account_id=b.principal_id)
    AND NOT EXISTS (SELECT FROM semantic.erasure_source_commit c WHERE c.partition_no=p_home AND c.epoch=p.epoch
                    AND c.position=p.position+1 AND c.xmin::text=pg_current_xact_id()::text);
  IF NOT FOUND THEN RETURN false; END IF;

  -- Each native receiving role list admits up to eight entries. Larger historical
  -- unions still use the scalar capture without retaining them all in memory.
  SELECT array_agg(r.role), bool_and(r.account_id=actor) INTO roles, same_account FROM (
    SELECT account_id, role FROM semantic.erasure_copy_role
    WHERE partition_no=p_home AND store=p_store AND record_key=p_key AND transaction_id=p_tx
    UNION ALL
    SELECT account_id, role FROM semantic.erasure_source_role WHERE partition_no=p_home AND transaction_id=p_tx
    LIMIT 17
  ) r;
  IF same_account IS FALSE OR cardinality(roles)>16 THEN RETURN false; END IF;
  roles := array_append(coalesce(roles, ARRAY[]::text[]), 'actor');

  SELECT record_key INTO provenance_key FROM semantic.erasure_provenance
  WHERE partition_no=p_home AND transaction_id=p_tx AND xmin::text=pg_current_xact_id()::text;
  IF NOT FOUND THEN
    INSERT INTO semantic.erasure_provenance(partition_no,transaction_id) VALUES(p_home,p_tx)
    ON CONFLICT(partition_no,transaction_id) DO UPDATE SET transaction_id=EXCLUDED.transaction_id
    RETURNING record_key INTO provenance_key;
  END IF;

  INSERT INTO semantic.erasure_locator
    (partition_no,account_id,role,store,record_key,source_transaction_id,source_position,delivery_position)
  SELECT p_home,actor,item.role,item.store,item.key,p_tx,native_position,native_position FROM (
    SELECT DISTINCT role, p_store AS store, p_key AS key FROM unnest(roles) AS granted(role)
    UNION ALL
    SELECT 'actor', 'write_basis', provenance_key WHERE NOT EXISTS (
      SELECT FROM semantic.erasure_locator l
      WHERE l.partition_no=p_home AND l.account_id=actor AND l.role='actor' AND l.store='write_basis'
        AND l.record_key=provenance_key AND l.source_transaction_id=p_tx
        AND l.source_position=native_position AND l.delivery_position=native_position
        AND l.xmin::text=pg_current_xact_id()::text
    )
  ) item
  ON CONFLICT(partition_no,account_id,role,store,record_key) DO UPDATE SET
    source_transaction_id=EXCLUDED.source_transaction_id, source_position=EXCLUDED.source_position,
    delivery_position=EXCLUDED.delivery_position,
    state=CASE WHEN erasure_locator.delivery_position IS DISTINCT FROM EXCLUDED.delivery_position
               THEN 'pending' ELSE erasure_locator.state END
  WHERE (erasure_locator.source_transaction_id,erasure_locator.source_position,erasure_locator.delivery_position)
     IS DISTINCT FROM (EXCLUDED.source_transaction_id,EXCLUDED.source_position,EXCLUDED.delivery_position);

  -- The normal locator trigger records every changed original. A previously
  -- complete home also reopens on a repeated report of pending work.
  UPDATE semantic.erasure_home h SET state='local'
  WHERE h.partition_no=p_home AND h.account_id=actor AND h.state='complete'
    AND EXISTS (SELECT FROM semantic.erasure_locator l WHERE l.partition_no=p_home AND l.account_id=actor
                AND l.state='pending' AND ((l.store=p_store AND l.record_key=p_key AND l.role=ANY(roles))
                  OR (l.store='write_basis' AND l.record_key=provenance_key AND l.role='actor')));
  RETURN true;
END; $$;

CREATE OR REPLACE FUNCTION semantic.capture_erasure_roles_unfunded(p_home integer, p_store text, p_key bigint, p_tx uuid)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE b editorial.write_basis; provenance_key bigint; r record; native_position bigint; acting_human uuid;
BEGIN
 IF semantic.capture_current_erasure_roles(p_home,p_store,p_key,p_tx) THEN RETURN; END IF;
 SELECT position INTO native_position FROM core.partition WHERE partition_no=p_home;
 FOR r IN SELECT account_id,role FROM semantic.erasure_copy_role
   WHERE partition_no=p_home AND store=p_store AND record_key=p_key AND transaction_id=p_tx LOOP
  PERFORM semantic.record_erasure_locator(p_home,r.account_id,r.role,p_store,p_key,p_tx,native_position);
 END LOOP;
 FOR r IN SELECT transaction_id,account_id,role FROM semantic.erasure_source_role
   WHERE partition_no=p_home AND transaction_id IN (p_tx,nullif(current_setting('semantic.erasure_native_transaction',true),'')::uuid) LOOP
  PERFORM semantic.record_erasure_locator(p_home,r.account_id,r.role,p_store,p_key,r.transaction_id,native_position);
 END LOOP;
 SELECT * INTO b FROM editorial.write_basis WHERE partition_no=p_home AND transaction_id=p_tx;
 IF NOT FOUND THEN RETURN; END IF;
 -- Every captured record can refer to the same immutable write basis. Its own
 -- transaction already holds the provenance row it just created or locked.
 SELECT record_key INTO provenance_key FROM semantic.erasure_provenance
 WHERE partition_no=p_home AND transaction_id=p_tx AND xmin::text=pg_current_xact_id()::text;
 IF NOT FOUND THEN
   INSERT INTO semantic.erasure_provenance(partition_no,transaction_id) VALUES(p_home,p_tx)
   ON CONFLICT(partition_no,transaction_id) DO UPDATE SET transaction_id=EXCLUDED.transaction_id
   RETURNING record_key INTO provenance_key;
 END IF;
 IF b.principal_kind='account' THEN
  PERFORM semantic.record_erasure_locator(p_home,b.principal_id,'actor',p_store,p_key,p_tx,b.position);
  PERFORM semantic.record_erasure_locator(p_home,b.principal_id,'actor','write_basis',provenance_key,p_tx,b.position);
 END IF;
 IF b.requested_by ~ '^urn:rezics:request:[0-9a-f-]{36}:[0-9a-f-]{36}$' THEN
  acting_human:=split_part(b.requested_by,':',4)::uuid;
  PERFORM semantic.record_erasure_locator(p_home,acting_human,'acting-human',p_store,p_key,p_tx,b.position);
  PERFORM semantic.record_erasure_locator(p_home,acting_human,'acting-human','write_basis',provenance_key,p_tx,b.position);
  PERFORM semantic.record_erasure_locator(p_home,b.principal_id,'delegate',p_store,p_key,p_tx,b.position);
 END IF;
END; $function$;

-- migrate:down
CREATE OR REPLACE FUNCTION semantic.capture_erasure_roles_unfunded(p_home integer, p_store text, p_key bigint, p_tx uuid)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE b editorial.write_basis; provenance_key bigint; r record; native_position bigint; acting_human uuid;
BEGIN
 SELECT position INTO native_position FROM core.partition WHERE partition_no=p_home;
 FOR r IN SELECT account_id,role FROM semantic.erasure_copy_role
   WHERE partition_no=p_home AND store=p_store AND record_key=p_key AND transaction_id=p_tx LOOP
  PERFORM semantic.record_erasure_locator(p_home,r.account_id,r.role,p_store,p_key,p_tx,native_position);
 END LOOP;
 FOR r IN SELECT transaction_id,account_id,role FROM semantic.erasure_source_role
   WHERE partition_no=p_home AND transaction_id IN (p_tx,nullif(current_setting('semantic.erasure_native_transaction',true),'')::uuid) LOOP
  PERFORM semantic.record_erasure_locator(p_home,r.account_id,r.role,p_store,p_key,r.transaction_id,native_position);
 END LOOP;
 SELECT * INTO b FROM editorial.write_basis WHERE partition_no=p_home AND transaction_id=p_tx;
 IF NOT FOUND THEN RETURN; END IF;
 -- Every captured record can refer to the same immutable write basis. Its own
 -- transaction already holds the provenance row it just created or locked.
 SELECT record_key INTO provenance_key FROM semantic.erasure_provenance
 WHERE partition_no=p_home AND transaction_id=p_tx AND xmin::text=pg_current_xact_id()::text;
 IF NOT FOUND THEN
   INSERT INTO semantic.erasure_provenance(partition_no,transaction_id) VALUES(p_home,p_tx)
   ON CONFLICT(partition_no,transaction_id) DO UPDATE SET transaction_id=EXCLUDED.transaction_id
   RETURNING record_key INTO provenance_key;
 END IF;
 IF b.principal_kind='account' THEN
  PERFORM semantic.record_erasure_locator(p_home,b.principal_id,'actor',p_store,p_key,p_tx,b.position);
  PERFORM semantic.record_erasure_locator(p_home,b.principal_id,'actor','write_basis',provenance_key,p_tx,b.position);
 END IF;
 IF b.requested_by ~ '^urn:rezics:request:[0-9a-f-]{36}:[0-9a-f-]{36}$' THEN
  acting_human:=split_part(b.requested_by,':',4)::uuid;
  PERFORM semantic.record_erasure_locator(p_home,acting_human,'acting-human',p_store,p_key,p_tx,b.position);
  PERFORM semantic.record_erasure_locator(p_home,acting_human,'acting-human','write_basis',provenance_key,p_tx,b.position);
  PERFORM semantic.record_erasure_locator(p_home,b.principal_id,'delegate',p_store,p_key,p_tx,b.position);
 END IF;
END; $function$;

DROP FUNCTION semantic.capture_current_erasure_roles(integer,text,bigint,uuid);
