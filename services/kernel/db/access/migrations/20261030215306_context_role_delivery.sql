-- migrate:up
-- Creator and unconverted Context roles are Source's applicability decision. Earlier capture
-- labelled them not-applicable without a receiver. Earlier delivery/key observations also lack
-- this receiver's enrollment proof; retain their metadata but restore genuine native pending input.
UPDATE access.resource_role_provenance SET delivery='pending'
 WHERE resource_type='semantic.context' AND delivery<>'pending';

CREATE FUNCTION access.guard_resource_role_provenance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.route,NEW.occurrence,NEW.resource_id,NEW.resource_type,NEW.original_creator,NEW.account_id,
        NEW.grant_role,NEW.valid,NEW.side,NEW.grant_transaction,NEW.source_transaction)
    IS DISTINCT FROM
    ROW(OLD.route,OLD.occurrence,OLD.resource_id,OLD.resource_type,OLD.original_creator,OLD.account_id,
        OLD.grant_role,OLD.valid,OLD.side,OLD.grant_transaction,OLD.source_transaction) THEN
   RAISE EXCEPTION 'Native role occurrence metadata is immutable' USING ERRCODE='23514';
 END IF;
 -- No real Source receiver is installed. A forward binding must replace this guard along with
 -- its same-transaction enrollment; a Context lookup or a caller's boolean cannot grant custody.
 IF NEW.resource_type='semantic.context' AND
    (NEW.context_key IS DISTINCT FROM OLD.context_key OR NEW.delivery IS DISTINCT FROM OLD.delivery) THEN
   RAISE EXCEPTION 'Context historical-party receiver unavailable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER resource_role_provenance_immutable BEFORE UPDATE ON access.resource_role_provenance
 FOR EACH ROW EXECUTE FUNCTION access.guard_resource_role_provenance();

CREATE FUNCTION access.try_deliver_resource_role_provenance(p_route integer,p_occurrence bigint)
 RETURNS text LANGUAGE plpgsql AS $$
DECLARE source access.resource_role_provenance;
BEGIN
 IF p_route IS NULL OR p_route NOT BETWEEN 0 AND 65535 OR p_occurrence IS NULL OR p_occurrence<=0 THEN
   RAISE EXCEPTION 'Invalid native role occurrence key' USING ERRCODE='22023';
 END IF;
 -- Serialize against the current native home, then against this exact original occurrence.
 PERFORM 1 FROM core.partition WHERE partition_no=p_route/16 AND write_state='active' FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Native Context home unavailable' USING ERRCODE='40001'; END IF;
 SELECT * INTO source FROM access.resource_role_provenance
   WHERE route=p_route AND occurrence=p_occurrence FOR UPDATE;
 IF NOT FOUND THEN RETURN 'missing'; END IF;
 IF source.route<>(get_byte(uuid_send(source.resource_id),10)*256+get_byte(uuid_send(source.resource_id),11))
    OR source.source_transaction='00000000-0000-0000-0000-000000000000'::uuid
    OR (source.side='creator' AND (source.account_id<>source.original_creator OR source.grant_role<>''
        OR source.grant_transaction IS NOT NULL OR source.valid IS NOT NULL))
    OR (source.side IN ('new','former') AND (source.grant_transaction IS NULL OR source.valid IS NULL)) THEN
   RAISE EXCEPTION 'Invalid native role occurrence provenance' USING ERRCODE='23514';
 END IF;
 IF source.delivery='delivered' THEN RETURN 'delivered'; END IF;
 IF source.resource_type='semantic.context' THEN
   -- Source owns applicability, erasure-key lookup, enrollment and generation/late-item closure.
   -- Bind only its published actual entrypoint here; no Source SQL or guessed ABI belongs here.
   RETURN 'receiver-unavailable';
 END IF;
 IF source.delivery='pending' THEN
   UPDATE access.resource_role_provenance SET delivery='not-applicable'
     WHERE route=source.route AND occurrence=source.occurrence AND delivery='pending';
 END IF;
 RETURN 'not-applicable';
END; $$;

CREATE OR REPLACE FUNCTION access.deliver_resource_role_provenance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM access.try_deliver_resource_role_provenance(NEW.route,NEW.occurrence);
 RETURN NEW;
END; $$;

-- migrate:down
-- Do not discard captured historical parties or restore the disabled guessed Source ABI.
