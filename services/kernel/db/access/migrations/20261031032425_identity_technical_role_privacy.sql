-- migrate:up
-- One atomic native schema transformation. Keep both immutable receipt components
-- untouched; remove copied business attribution, including inherited History roles.
LOCK TABLE access.agent_identity_technical_source,access.agent_identity_technical_role IN ACCESS EXCLUSIVE MODE;

-- This narrow guard exists only inside this owner migration transaction. Provenance
-- is the owning native function's actual catalog transaction and table owner, not a
-- caller-set cleanup flag. The original rejecting guard is restored before commit.
CREATE OR REPLACE FUNCTION access.guard_identity_technical_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_RELID='access.agent_identity_technical_role'::regclass AND TG_LEVEL='ROW'
  AND EXISTS(SELECT 1 FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner
    WHERE c.oid=TG_RELID AND r.rolname=current_user)
  AND EXISTS(SELECT 1 FROM pg_proc p
    WHERE p.oid='access.guard_identity_technical_source()'::regprocedure
      AND p.xmin::text=pg_current_xact_id()::text)
  AND EXISTS(SELECT 1 FROM access.agent_identity_technical_source s
    WHERE (s.route,s.account_id,s.direction,s.receipt_id)=
      (OLD.route,OLD.account_id,OLD.direction,OLD.receipt_id)) THEN
  IF TG_OP='DELETE' AND OLD.role_account_id<>OLD.account_id THEN RETURN OLD; END IF;
  IF TG_OP='UPDATE' AND OLD.role_account_id=OLD.account_id
    AND (NEW.route,NEW.account_id,NEW.direction,NEW.receipt_id,NEW.role_account_id)
      IS NOT DISTINCT FROM (OLD.route,OLD.account_id,OLD.direction,OLD.receipt_id,OLD.role_account_id)
    AND NEW.roles=32 AND NEW.source_roles=1 THEN RETURN NEW; END IF;
 END IF;
 RAISE EXCEPTION 'Accepted Accounts technical custody requires its native consumer release';
END; $$;

DO $$
DECLARE
 item record;
 last_route integer := -1;
 last_account uuid := '00000000-0000-0000-0000-000000000000';
 last_direction text := '';
 last_receipt uuid := '00000000-0000-0000-0000-000000000000';
 last_role uuid := '00000000-0000-0000-0000-000000000000';
 raw_count integer;
BEGIN
 LOOP
  raw_count := 0;
  -- The FK bounds direction to the two native strings. Five scalar keys and two
  -- masks are below 1 KiB per locator and 64 KiB per 100-raw-row page. No payloads,
  -- original source scope, History artifacts or other families are read/redriven.
  FOR item IN SELECT * FROM access.agent_identity_technical_role
    WHERE (route,account_id,direction,receipt_id,role_account_id)>
      (last_route,last_account,last_direction,last_receipt,last_role)
    ORDER BY route,account_id,direction,receipt_id,role_account_id LIMIT 100
  LOOP
   IF item.role_account_id<>item.account_id THEN
    DELETE FROM access.agent_identity_technical_role
     WHERE (route,account_id,direction,receipt_id,role_account_id)=
       (item.route,item.account_id,item.direction,item.receipt_id,item.role_account_id);
   ELSIF item.roles<>32 OR item.source_roles<>1 THEN
    UPDATE access.agent_identity_technical_role SET roles=32,source_roles=1
     WHERE (route,account_id,direction,receipt_id,role_account_id)=
       (item.route,item.account_id,item.direction,item.receipt_id,item.role_account_id);
   END IF;
   last_route := item.route;
   last_account := item.account_id;
   last_direction := item.direction;
   last_receipt := item.receipt_id;
   last_role := item.role_account_id;
   raw_count := raw_count+1;
  END LOOP;
  EXIT WHEN raw_count<100;
 END LOOP;
END; $$;

CREATE OR REPLACE FUNCTION access.guard_identity_technical_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'Accepted Accounts technical custody requires its native consumer release';
END; $$;

-- A technical Account inventory covers only the Account subject actually retained.
-- The original source-role mask is neither technical input nor a private hash substitute.
ALTER TABLE access.agent_identity_technical_role DROP COLUMN source_roles;
ALTER TABLE access.agent_identity_technical_role ADD CONSTRAINT identity_technical_retained_subject
 CHECK(role_account_id=account_id AND roles=32);

CREATE OR REPLACE FUNCTION access.validate_identity_technical_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.receiving_transaction_id::text IS DISTINCT FROM current_setting('access.identity_technical_transaction',true)
  OR NOT EXISTS(SELECT 1 FROM core.outbox o JOIN core.partition p USING(partition_no)
    WHERE o.partition_no=NEW.source_partition AND o.epoch=NEW.receiving_epoch
      AND o.position=NEW.receiving_position AND o.event_seq=0
      AND o.xmin::text=pg_current_xact_id()::text
      AND p.epoch=o.epoch AND p.position=o.position AND p.write_state='active')
  OR NOT EXISTS(SELECT 1 FROM access.agent_identity_technical_role r
    WHERE (r.route,r.account_id,r.direction,r.receipt_id)=
      (NEW.route,NEW.account_id,NEW.direction,NEW.receipt_id)
      AND r.role_account_id=NEW.account_id AND r.roles=32) THEN
  RAISE EXCEPTION 'Accounts technical custody lacks same-command native receiving fence/inventory' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END; $$;

-- migrate:down
DO $$ BEGIN RAISE EXCEPTION 'Technical identity privacy cleanup is forward-only; erased attribution cannot be restored'; END $$;
