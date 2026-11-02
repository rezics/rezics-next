-- migrate:up
-- Live business copies are separate from History's erased-artifact families.
ALTER TABLE access.lifecycle_coordination DROP CONSTRAINT lifecycle_coordination_purpose_check;
ALTER TABLE access.lifecycle_coordination ADD CONSTRAINT lifecycle_coordination_purpose_check
 CHECK (purpose IN ('membership','operator','live-copy'));

CREATE TABLE access.live_copy_domain (
 partition_no integer PRIMARY KEY REFERENCES core.partition(partition_no),
 domain_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
 node text NOT NULL, epoch integer NOT NULL CHECK (epoch>0),
 admitted_position bigint NOT NULL CHECK (admitted_position>=0),
 state text NOT NULL CHECK (state IN ('active','isolated'))
);
-- This migration is the initial admission barrier, not an application-side lazy seed.
-- Pre-existing projections remain covered by their original bounded recovery frontiers.
INSERT INTO access.live_copy_domain(partition_no,node,epoch,admitted_position,state)
 SELECT partition_no,node,epoch,position,CASE WHEN write_state='active' THEN 'active' ELSE 'isolated' END
 FROM core.partition;

CREATE TABLE access.live_copy_transition (
 route integer NOT NULL CHECK(route BETWEEN 0 AND 65535), transition_id uuid NOT NULL,
 module text NOT NULL CHECK(module IN ('commerce.creator-sale','library.subject-listing')),
 source_domain uuid NOT NULL, source_epoch integer NOT NULL CHECK(source_epoch>0),
 effect_key jsonb NOT NULL CHECK(octet_length(effect_key::text)<=1024),
 effect_digest bytea NOT NULL CHECK(octet_length(effect_digest)=32),
 receiver_route integer NOT NULL CHECK(receiver_route BETWEEN 0 AND 65535),
 receiver_domain uuid NOT NULL, receiver_epoch integer NOT NULL CHECK(receiver_epoch>0),
 payload jsonb, roles jsonb,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','complete','retired')),
 result_id uuid, outcome text CHECK(outcome IN ('applied','cancelled','superseded')),
 next_run timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(route,transition_id), UNIQUE(route,module,source_domain,effect_digest), UNIQUE(route,module,source_domain,effect_key),
 CHECK(route=(get_byte(uuid_send(transition_id),10)*256+get_byte(uuid_send(transition_id),11))),
 CHECK(payload IS NULL OR octet_length(payload::text)<=8192),
 CHECK(roles IS NULL OR (jsonb_typeof(roles)='array' AND jsonb_array_length(roles)<=64 AND octet_length(roles::text)<=8192)),
 CHECK((result_id IS NULL)=(outcome IS NULL)),
 CHECK((state='pending')=(result_id IS NULL)),
 CHECK(state='retired' OR (payload IS NOT NULL AND roles IS NOT NULL))
);
CREATE INDEX live_copy_transition_pending ON access.live_copy_transition(route,next_run,transition_id) WHERE state='pending';
-- A negative role result exists even when admission never arrived. It contains
-- only protocol coordinates, so closing an unadmitted role adds no account payload.
CREATE TABLE access.live_copy_role_gate (
 route integer NOT NULL, source_domain uuid NOT NULL, transition_id uuid NOT NULL,
 role_index integer NOT NULL CHECK(role_index BETWEEN 0 AND 63),
 result_id uuid, outcome text CHECK(outcome IN ('applied','cancelled','superseded')),
 PRIMARY KEY(route,source_domain,transition_id,role_index),
 CHECK((result_id IS NULL)=(outcome IS NULL))
);
CREATE TABLE access.live_copy_hold (
 route integer NOT NULL, account_id uuid NOT NULL, transition_id uuid NOT NULL,
 source_route integer NOT NULL, source_domain uuid NOT NULL, source_transaction_id uuid NOT NULL,
 receiver_route integer NOT NULL, receiver_domain uuid NOT NULL, receiver_epoch integer NOT NULL,
 account_domain uuid NOT NULL, roles integer NOT NULL CHECK(roles BETWEEN 1 AND 262143),
 role_index integer NOT NULL CHECK(role_index BETWEEN 0 AND 63),
 reservation_id uuid NOT NULL, result_id uuid, outcome text CHECK(outcome IN ('applied','cancelled','superseded')),
 PRIMARY KEY(route,account_id,source_domain,transition_id), UNIQUE(route,account_id,reservation_id),
 CHECK(route=(get_byte(uuid_send(account_id),10)*256+get_byte(uuid_send(account_id),11))),
 CHECK((result_id IS NULL)=(outcome IS NULL))
);
CREATE INDEX live_copy_hold_pending ON access.live_copy_hold(route,account_id,reservation_id) WHERE result_id IS NULL;
CREATE TABLE access.live_copy_gate (
 route integer NOT NULL, source_domain uuid NOT NULL, transition_id uuid NOT NULL,
 receiver_domain uuid NOT NULL, receiver_epoch integer NOT NULL,
 module text NOT NULL CHECK(module IN ('commerce.creator-sale','library.subject-listing')),
 effect_key jsonb, payload jsonb, roles jsonb,
 outcome text NOT NULL CHECK(outcome IN ('applying','applied','cancelled','superseded')),
 result_id uuid NOT NULL DEFAULT gen_random_uuid(), retired boolean NOT NULL DEFAULT false,
 applying_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
 PRIMARY KEY(route,source_domain,transition_id),
 CHECK(effect_key IS NULL OR octet_length(effect_key::text)<=1024),
 CHECK(payload IS NULL OR octet_length(payload::text)<=8192),
 CHECK(roles IS NULL OR (jsonb_array_length(roles)<=64 AND octet_length(roles::text)<=8192)),
 CHECK(retired OR (effect_key IS NOT NULL AND payload IS NOT NULL AND roles IS NOT NULL))
);
-- At most one open receiver effect per native transaction. Projection guards seek
-- this exact current transaction; old prepared writers cannot bypass admission.
CREATE UNIQUE INDEX live_copy_gate_applying ON access.live_copy_gate(route,applying_transaction) WHERE outcome='applying';
-- Exact role-first native inverse. Discovery visits at most 4096 receiver homes,
-- raw100 rows/64KiB and 1KiB locators through the existing Accounts coordinator.
CREATE TABLE access.live_copy_inventory (
 route integer NOT NULL, account_id uuid NOT NULL,
 item text NOT NULL CHECK(item IN ('source','hold','receiver')),
 source_domain uuid NOT NULL, transition_id uuid NOT NULL,
 PRIMARY KEY(route,account_id,item,source_domain,transition_id)
);
CREATE INDEX live_copy_inventory_account ON access.live_copy_inventory(account_id,route,item,source_domain,transition_id);

CREATE FUNCTION access.guard_live_copy_hold() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.result_id IS NOT NULL OR NOT EXISTS(SELECT 1 FROM access.live_copy_role_gate g
   WHERE (g.route,g.source_domain,g.transition_id,g.role_index)=(NEW.route,NEW.source_domain,NEW.transition_id,NEW.role_index)
   AND g.result_id IS NULL) THEN RAISE EXCEPTION 'Live copy role gate is closed' USING ERRCODE='23514'; END IF;
  PERFORM 1 FROM access.account a WHERE a.route=NEW.route AND a.account_id=NEW.account_id
    AND a.state='active' AND NOT a.authn_fenced FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Live copy requires an active native role account' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS(SELECT 1 FROM access.live_copy_domain d JOIN core.partition p USING(partition_no)
    WHERE d.partition_no=NEW.route>>4 AND d.domain_id=NEW.account_domain AND d.state='active'
      AND (d.node,d.epoch)=(p.node,p.epoch) AND p.write_state='active') THEN
   RAISE EXCEPTION 'Live copy account domain unavailable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 IF TG_OP='UPDATE' AND OLD.result_id IS NULL AND NEW.result_id IS NOT NULL
   AND (to_jsonb(OLD)-'result_id'-'outcome')=(to_jsonb(NEW)-'result_id'-'outcome') THEN RETURN NEW; END IF;
 IF TG_OP='DELETE' AND OLD.result_id IS NOT NULL AND current_setting('rezics.erasure_progress',true) IS NOT NULL THEN RETURN OLD; END IF;
 RAISE EXCEPTION 'Live copy hold identity and terminal result are immutable' USING ERRCODE='23514';
END; $$;
CREATE TRIGGER live_copy_hold_guard BEFORE INSERT OR UPDATE OR DELETE ON access.live_copy_hold
 FOR EACH ROW EXECUTE FUNCTION access.guard_live_copy_hold();
CREATE FUNCTION access.live_copy_coordination_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.purpose='live-copy' AND (NEW.related_account_id<>NEW.account_id OR NOT EXISTS(
    SELECT 1 FROM access.live_copy_hold h WHERE (h.route,h.account_id,h.reservation_id)=(NEW.route,NEW.account_id,NEW.reservation_id)
      AND h.source_transaction_id=NEW.transaction_id AND h.result_id IS NULL)) THEN
   RAISE EXCEPTION 'Live copy coordination requires native original hold' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 IF OLD.purpose='live-copy' AND NOT EXISTS(SELECT 1 FROM access.live_copy_hold h
   WHERE (h.route,h.account_id,h.reservation_id)=(OLD.route,OLD.account_id,OLD.reservation_id)
   AND h.result_id IS NOT NULL) THEN
  RAISE EXCEPTION 'Live copy coordination requires exact terminal consumption' USING ERRCODE='23514';
 END IF;
 IF TG_OP='UPDATE' THEN
  IF OLD.purpose='live-copy' OR NEW.purpose='live-copy' THEN
   RAISE EXCEPTION 'Live copy coordination identity is immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 RETURN OLD;
END; $$;
CREATE TRIGGER live_copy_coordination_guard BEFORE INSERT OR DELETE OR UPDATE ON access.lifecycle_coordination
 FOR EACH ROW EXECUTE FUNCTION access.live_copy_coordination_guard();
CREATE FUNCTION access.guard_live_copy_gate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND OLD.outcome='applying' AND NEW.outcome IN ('applied','superseded')
   AND (to_jsonb(OLD)-'outcome')=(to_jsonb(NEW)-'outcome') THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND OLD.outcome<>'applying' AND NOT OLD.retired AND NEW.retired
   AND NEW.effect_key IS NULL AND NEW.payload IS NULL AND NEW.roles IS NULL
   AND (to_jsonb(OLD)-'effect_key'-'payload'-'roles'-'retired')=(to_jsonb(NEW)-'effect_key'-'payload'-'roles'-'retired')
   AND current_setting('rezics.erasure_progress',true) IS NOT NULL THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'Live copy receiver result is immutable' USING ERRCODE='23514';
END; $$;
CREATE TRIGGER live_copy_gate_guard BEFORE UPDATE OR DELETE ON access.live_copy_gate
 FOR EACH ROW EXECUTE FUNCTION access.guard_live_copy_gate();
CREATE FUNCTION access.live_copy_gate_commit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM access.live_copy_gate WHERE route=NEW.route AND source_domain=NEW.source_domain
    AND transition_id=NEW.transition_id AND outcome='applying') THEN
  RAISE EXCEPTION 'Live copy effect and terminal result must commit together' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER live_copy_gate_commit AFTER INSERT OR UPDATE ON access.live_copy_gate
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION access.live_copy_gate_commit();
CREATE FUNCTION access.guard_live_copy_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND OLD.state='pending' AND NEW.state='pending'
  AND (to_jsonb(OLD)-'next_run')=(to_jsonb(NEW)-'next_run') THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND OLD.state='pending' AND NEW.state='complete' AND NEW.result_id IS NOT NULL
  AND (to_jsonb(OLD)-'state'-'result_id'-'outcome'-'next_run')=(to_jsonb(NEW)-'state'-'result_id'-'outcome'-'next_run') THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND OLD.state='complete' AND NEW.state='retired' AND NEW.payload IS NULL AND NEW.roles IS NULL
  AND NEW.effect_key=jsonb_build_object('retired',OLD.transition_id)
  AND (to_jsonb(OLD)-'state'-'payload'-'roles'-'effect_key')=(to_jsonb(NEW)-'state'-'payload'-'roles'-'effect_key')
  AND current_setting('rezics.erasure_progress',true) IS NOT NULL THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'Live copy original source and effect are immutable' USING ERRCODE='23514';
END; $$;
CREATE TRIGGER live_copy_transition_guard BEFORE UPDATE OR DELETE ON access.live_copy_transition
 FOR EACH ROW EXECUTE FUNCTION access.guard_live_copy_transition();
-- All normal account terminal writers use the existing responsibility trigger.
-- A physical DELETE must not evade it either.
CREATE FUNCTION access.live_copy_account_delete_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM access.lifecycle_coordination WHERE route=OLD.route AND account_id=OLD.account_id AND purpose='live-copy') THEN
  RAISE EXCEPTION 'Unresolved account responsibility' USING ERRCODE='23514'; END IF;
 RETURN OLD;
END; $$;
CREATE TRIGGER live_copy_account_delete_guard BEFORE DELETE ON access.account
 FOR EACH ROW EXECUTE FUNCTION access.live_copy_account_delete_guard();
CREATE FUNCTION access.live_copy_partition_activation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.write_state='active' AND (TG_OP='INSERT' OR
    (NEW.node,NEW.epoch,NEW.write_state) IS DISTINCT FROM (OLD.node,OLD.epoch,OLD.write_state))
  AND NOT EXISTS(SELECT 1 FROM access.live_copy_domain d
   WHERE d.partition_no=NEW.partition_no AND d.state='active' AND (d.node,d.epoch)=(NEW.node,NEW.epoch)) THEN
  RAISE EXCEPTION 'Live copy domain requires native lineage reconciliation before activation' USING ERRCODE='23514'; END IF;
 IF TG_OP='UPDATE' AND NEW.position<OLD.position THEN
  RAISE EXCEPTION 'Live copy committed tail cannot move backwards online' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER live_copy_partition_activation_guard BEFORE INSERT OR UPDATE ON core.partition
 FOR EACH ROW EXECUTE FUNCTION access.live_copy_partition_activation_guard();
CREATE FUNCTION access.guard_live_copy_role_gate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND OLD.result_id IS NULL AND NEW.result_id IS NOT NULL
  AND (to_jsonb(OLD)-'result_id'-'outcome')=(to_jsonb(NEW)-'result_id'-'outcome') THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'Live copy role closure is immutable' USING ERRCODE='23514';
END; $$;
CREATE TRIGGER live_copy_role_gate_guard BEFORE UPDATE OR DELETE ON access.live_copy_role_gate
 FOR EACH ROW EXECUTE FUNCTION access.guard_live_copy_role_gate();
-- Source business intents are disposable copies, independent of financial retention.
CREATE TABLE access.live_copy_business_inventory (
 route integer NOT NULL, account_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('commerce-work','commerce-receipt')),
 locator jsonb NOT NULL CHECK(octet_length(locator::text)<=1024),
 PRIMARY KEY(route,account_id,kind,locator)
);
CREATE INDEX live_copy_business_inventory_account ON access.live_copy_business_inventory(account_id,route,kind,locator);
CREATE INDEX live_copy_order_pending ON access.live_copy_transition(route,(effect_key->>'orderId'))
 WHERE module='commerce.creator-sale' AND state='pending';
CREATE TABLE access.live_copy_seal (
 partition_no integer NOT NULL, account_id uuid NOT NULL, sealed boolean NOT NULL DEFAULT false,
 PRIMARY KEY(partition_no,account_id)
);
CREATE FUNCTION access.guard_live_copy_inventory() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE closed boolean;
BEGIN
 INSERT INTO access.live_copy_seal(partition_no,account_id) VALUES(NEW.route>>4,NEW.account_id) ON CONFLICT DO NOTHING;
 SELECT sealed INTO STRICT closed FROM access.live_copy_seal WHERE partition_no=NEW.route>>4 AND account_id=NEW.account_id FOR SHARE;
 IF closed THEN RAISE EXCEPTION 'Live copy inventory sealed for account erasure' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER live_copy_inventory_guard BEFORE INSERT ON access.live_copy_inventory
 FOR EACH ROW EXECUTE FUNCTION access.guard_live_copy_inventory();
CREATE TRIGGER live_copy_business_inventory_guard BEFORE INSERT ON access.live_copy_business_inventory
 FOR EACH ROW EXECUTE FUNCTION access.guard_live_copy_inventory();
CREATE FUNCTION access.preserve_live_copy_seal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND NOT OLD.sealed AND NEW.sealed
   AND (NEW.partition_no,NEW.account_id)=(OLD.partition_no,OLD.account_id) THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'Live copy account seal is permanent' USING ERRCODE='23514';
END; $$;
CREATE TRIGGER live_copy_seal_guard BEFORE UPDATE OR DELETE ON access.live_copy_seal
 FOR EACH ROW EXECUTE FUNCTION access.preserve_live_copy_seal();
-- Application writers cannot seed or rotate a domain. Database-owner migration must
-- isolate the home and reconcile its committed lineage before replacing this guard.
CREATE FUNCTION access.preserve_live_copy_domain() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'Live copy domains require controlled native migration' USING ERRCODE='23514';
END; $$;
CREATE TRIGGER live_copy_domain_guard BEFORE INSERT OR UPDATE OR DELETE ON access.live_copy_domain
 FOR EACH ROW EXECUTE FUNCTION access.preserve_live_copy_domain();
CREATE TABLE access.live_copy_bootstrap (
 partition_no integer PRIMARY KEY REFERENCES core.partition(partition_no),
 after_route integer NOT NULL, after_subject uuid NOT NULL, after_collection uuid NOT NULL,
 covered boolean NOT NULL DEFAULT false,
 sales_after_route integer NOT NULL, sales_after_creator uuid NOT NULL, sales_after_order uuid NOT NULL,
 sales_covered boolean NOT NULL DEFAULT false,
 work_after_route integer NOT NULL, work_after_order uuid NOT NULL,
 work_covered boolean NOT NULL DEFAULT false,
 receipt_after_position bigint NOT NULL DEFAULT 0, receipt_after_event integer NOT NULL DEFAULT -1,
 receipts_covered boolean NOT NULL DEFAULT false
);
INSERT INTO access.live_copy_bootstrap(partition_no,after_route,after_subject,after_collection,sales_after_route,sales_after_creator,sales_after_order,work_after_route,work_after_order)
 SELECT partition_no,partition_no*16,'00000000-0000-0000-0000-000000000000','00000000-0000-0000-0000-000000000000',
 partition_no*16,'00000000-0000-0000-0000-000000000000','00000000-0000-0000-0000-000000000000',
 partition_no*16,'00000000-0000-0000-0000-000000000000' FROM core.partition;
-- The two appended native discovery groups are new obligations. A previous
-- native checkpoint cannot certify these newly installed inventories.
UPDATE access.erasure_native_progress SET native_complete_at=NULL,pending='native-inventory'
 WHERE native_complete_at IS NOT NULL;
-- migrate:down
-- Forward only.
