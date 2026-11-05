-- migrate:up
-- Both the deferred producer trigger and command-body redrive lock literal native input.
-- Source alone owns applicability, Context erasure keys, enrollment and late admission.
CREATE FUNCTION access.lock_resource_role_provenance(p_route integer,p_occurrence bigint)
 RETURNS SETOF access.resource_role_provenance LANGUAGE plpgsql AS $$
DECLARE source access.resource_role_provenance;
BEGIN
 IF p_route IS NULL OR p_route NOT BETWEEN 0 AND 65535 OR p_occurrence IS NULL OR p_occurrence<=0 THEN
   RAISE EXCEPTION 'Invalid native role occurrence key' USING ERRCODE='22023';
 END IF;
 PERFORM 1 FROM core.partition WHERE partition_no=p_route/16 AND write_state='active' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Native Context home unavailable' USING ERRCODE='40001'; END IF;
 SELECT * INTO source FROM access.resource_role_provenance
   WHERE route=p_route AND occurrence=p_occurrence FOR UPDATE;
 IF NOT FOUND THEN RETURN; END IF;
 IF source.route<>(get_byte(uuid_send(source.resource_id),10)*256+get_byte(uuid_send(source.resource_id),11))
    OR source.source_transaction='00000000-0000-0000-0000-000000000000'::uuid
    OR (source.side='creator' AND (source.account_id<>source.original_creator OR source.grant_role<>''
        OR source.grant_transaction IS NOT NULL OR source.valid IS NOT NULL))
    OR (source.side IN ('new','former') AND (source.grant_transaction IS NULL OR source.valid IS NULL)) THEN
   RAISE EXCEPTION 'Invalid native role occurrence provenance' USING ERRCODE='23514';
 END IF;
 RETURN NEXT source;
END; $$;

CREATE OR REPLACE FUNCTION access.guard_resource_role_provenance() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE enrolled record;
BEGIN
 IF ROW(NEW.route,NEW.occurrence,NEW.resource_id,NEW.resource_type,NEW.original_creator,NEW.account_id,
        NEW.grant_role,NEW.valid,NEW.side,NEW.grant_transaction,NEW.source_transaction)
    IS DISTINCT FROM
    ROW(OLD.route,OLD.occurrence,OLD.resource_id,OLD.resource_type,OLD.original_creator,OLD.account_id,
        OLD.grant_role,OLD.valid,OLD.side,OLD.grant_transaction,OLD.source_transaction) THEN
   RAISE EXCEPTION 'Native role occurrence metadata is immutable' USING ERRCODE='23514';
 END IF;
 IF NEW.resource_type='semantic.context' AND
    (NEW.context_key IS DISTINCT FROM OLD.context_key OR NEW.delivery IS DISTINCT FROM OLD.delivery) THEN
   IF OLD.delivery<>'pending' OR NEW.delivery='pending' THEN
     RAISE EXCEPTION 'Invalid native Context delivery transition' USING ERRCODE='23514';
   END IF;
   -- Re-run the real, idempotent Source port rather than trusting a supplied result/key.
   -- This also protects direct SQL updates without reading any Source-owned table.
   IF to_regprocedure('semantic.enroll_context_role_provenance(integer,bigint,uuid,uuid,uuid,text,text,text,uuid,uuid)') IS NULL THEN
     RAISE EXCEPTION 'Context historical-party receiver unavailable' USING ERRCODE='23514';
   END IF;
   SELECT * INTO enrolled FROM semantic.enroll_context_role_provenance(
     OLD.route,OLD.occurrence,OLD.resource_id,OLD.original_creator,OLD.account_id,OLD.grant_role,
     OLD.valid::text,OLD.side,OLD.grant_transaction,OLD.source_transaction);
   IF NOT FOUND THEN
     RAISE EXCEPTION 'Context historical-party enrollment unresolved' USING ERRCODE='23514';
   END IF;
   IF NOT coalesce(
     (NEW.delivery='delivered' AND enrolled.state='enrolled' AND enrolled.context_key>0
       AND NEW.context_key=enrolled.context_key)
     OR (NEW.delivery='not-applicable' AND enrolled.state='not-applicable' AND NEW.context_key IS NULL),false) THEN
     RAISE EXCEPTION 'Context delivery requires actual native Source enrollment' USING ERRCODE='23514';
   END IF;
 END IF;
 RETURN NEW;
END; $$;

CREATE OR REPLACE FUNCTION access.try_deliver_resource_role_provenance(p_route integer,p_occurrence bigint)
 RETURNS text LANGUAGE plpgsql AS $$
DECLARE source access.resource_role_provenance; enrolled record;
BEGIN
 SELECT * INTO source FROM access.lock_resource_role_provenance(p_route,p_occurrence);
 IF NOT FOUND THEN RETURN 'missing'; END IF;
 IF source.delivery<>'pending' THEN RETURN source.delivery; END IF;
 IF source.resource_type='semantic.context' THEN
   IF to_regprocedure('semantic.enroll_context_role_provenance(integer,bigint,uuid,uuid,uuid,text,text,text,uuid,uuid)') IS NULL THEN
     RETURN 'receiver-unavailable';
   END IF;
   -- At the original deferred trigger the executor has already written its genuine
   -- editorial basis. No setting or made-up Source commit substitutes for that basis.
   SELECT * INTO enrolled FROM semantic.enroll_context_role_provenance(
     source.route,source.occurrence,source.resource_id,source.original_creator,source.account_id,source.grant_role,
     source.valid::text,source.side,source.grant_transaction,source.source_transaction);
   IF NOT FOUND THEN RETURN 'pending'; END IF;
   IF enrolled.state='pending' THEN RETURN 'pending'; END IF;
   IF enrolled.state='enrolled' AND enrolled.context_key>0 THEN
     UPDATE access.resource_role_provenance SET delivery='delivered',context_key=enrolled.context_key
       WHERE route=source.route AND occurrence=source.occurrence AND delivery='pending';
     RETURN 'delivered';
   ELSIF enrolled.state='not-applicable' THEN
     UPDATE access.resource_role_provenance SET delivery='not-applicable',context_key=NULL
       WHERE route=source.route AND occurrence=source.occurrence AND delivery='pending';
     RETURN 'not-applicable';
   END IF;
   RAISE EXCEPTION 'Invalid native Context enrollment result' USING ERRCODE='23514';
 END IF;
 UPDATE access.resource_role_provenance SET delivery='not-applicable'
   WHERE route=source.route AND occurrence=source.occurrence AND delivery='pending';
 RETURN 'not-applicable';
END; $$;

-- migrate:down
-- Preserve immutable captured parties and accepted receiving state; never restore a guessed ABI.
