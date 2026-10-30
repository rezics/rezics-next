-- migrate:up
-- One local physical database domain. Routing/restore and definition changes serialize with
-- final verification. Remote databases cannot be represented by this local certificate.
CREATE TABLE core.history_family_domain (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  generation bigint NOT NULL DEFAULT 1 CHECK(generation>0)
);
INSERT INTO core.history_family_domain(singleton) VALUES(true);
CREATE TABLE core.history_family_definition (
  family text PRIMARY KEY CHECK(family IN ('access','commerce','community','content','library','rating','semantic','zones','imports')),
  version integer NOT NULL CHECK(version>0),
  digest text NOT NULL CHECK(digest ~ '^[0-9a-f]{64}$'),
  registry_digest text NOT NULL CHECK(registry_digest ~ '^[0-9a-f]{64}$'),
  sources jsonb NOT NULL CHECK(jsonb_typeof(sources)='array' AND jsonb_array_length(sources) BETWEEN 1 AND 100),
  admit_cursor uuid,
  admission_complete boolean NOT NULL DEFAULT false
);
CREATE TABLE core.history_family_fence (
  account_route integer NOT NULL, account_id uuid NOT NULL,
  revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
  PRIMARY KEY(account_route,account_id),
  FOREIGN KEY(account_route,account_id) REFERENCES access.erasure(route,account_id)
);
-- The producer owner supplies these from its actual immutable historical source inventory,
-- after enrolling all original/receiving roles and fencing its late writers. A registry entry,
-- a terminal Source page, and a participant ACK cannot insert these on the owner's behalf.
CREATE TABLE core.history_family_enrollment (
  family text NOT NULL REFERENCES core.history_family_definition(family),
  account_route integer NOT NULL, account_id uuid NOT NULL,
  partition_no integer NOT NULL REFERENCES core.partition(partition_no),
  artifact_type text COLLATE "C" NOT NULL CHECK(artifact_type IN ('command-receipt/v1','outbox-event/v1','durable-work/v1')),
  producer text NOT NULL CHECK(producer ~ '^[a-z][a-z0-9_.-]{0,95}$'),
  producer_version integer NOT NULL CHECK(producer_version>0),
  definition_digest text NOT NULL CHECK(definition_digest ~ '^[0-9a-f]{64}$'),
  barrier_version integer NOT NULL CHECK(barrier_version>0), barrier_at text NOT NULL,
  partition_epoch integer NOT NULL CHECK(partition_epoch>0),
  source_cut bytea NOT NULL CHECK(octet_length(source_cut) BETWEEN 1 AND 256),
  PRIMARY KEY(family,account_route,account_id,partition_no,artifact_type,producer),
  FOREIGN KEY(account_route,account_id) REFERENCES access.erasure(route,account_id),
  FOREIGN KEY(partition_no,account_route,account_id)
    REFERENCES core.history_seal(partition_no,account_route,account_id)
);
CREATE TABLE core.history_family_coverage (
  family text NOT NULL REFERENCES core.history_family_definition(family),
  account_route integer NOT NULL, account_id uuid NOT NULL,
  barrier_version integer NOT NULL CHECK(barrier_version>0), barrier_at text NOT NULL,
  definition_digest text NOT NULL, domain_generation bigint NOT NULL, fence_revision bigint NOT NULL,
  partition_cursor integer NOT NULL DEFAULT -1 CHECK(partition_cursor BETWEEN -1 AND 4095),
  current_partition integer CHECK(current_partition BETWEEN 0 AND 4095),
  artifact_type text COLLATE "C", locator bytea CHECK(octet_length(locator) BETWEEN 1 AND 256),
  phase text NOT NULL DEFAULT 'scan' CHECK(phase IN ('scan','pending','complete')),
  gap text CHECK(octet_length(gap)<=256),
  proof_id uuid,
  next_run timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(family,account_route,account_id),
  FOREIGN KEY(account_route,account_id) REFERENCES access.erasure(route,account_id),
  CHECK((artifact_type IS NULL)=(locator IS NULL)),
  CHECK((phase='complete')=(proof_id IS NOT NULL)),
  CHECK((phase='pending')=(gap IS NOT NULL))
);
CREATE INDEX history_family_runnable ON core.history_family_coverage(next_run,family,account_route,account_id)
  WHERE phase='scan';
-- Exact physical key watches are installed under the physical source's SHARE lock. They contain
-- opaque native keys only, never payloads. A changed physical source invalidates its role union.
CREATE TABLE core.history_family_watch (
  partition_no integer NOT NULL, artifact_type text COLLATE "C" NOT NULL, locator bytea NOT NULL,
  source_key jsonb NOT NULL CHECK(octet_length(source_key::text)<=1024),
  PRIMARY KEY(partition_no,artifact_type,locator)
);
CREATE UNIQUE INDEX history_family_watch_source ON core.history_family_watch(partition_no,artifact_type,source_key);
CREATE INDEX history_locator_family_page ON core.history_locator(partition_no,account_route,account_id,artifact_type,locator);
CREATE FUNCTION core.history_family_domain_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_LEVEL='ROW' AND TG_OP='UPDATE' THEN
  IF OLD IS NOT DISTINCT FROM NEW THEN RETURN NULL; END IF;
 END IF;
 UPDATE core.history_family_domain SET generation=generation+1 WHERE singleton;
 RETURN NULL;
END; $$;
CREATE TRIGGER history_family_route_changed AFTER INSERT OR UPDATE OF node,write_state,moved_to,epoch OR DELETE ON core.partition
 FOR EACH STATEMENT EXECUTE FUNCTION core.history_family_domain_changed();
CREATE TRIGGER history_family_definition_changed AFTER INSERT OR UPDATE OF version,digest,sources,registry_digest OR DELETE ON core.history_family_definition
 FOR EACH ROW EXECUTE FUNCTION core.history_family_domain_changed();
CREATE TRIGGER history_family_registry_changed AFTER INSERT OR UPDATE OR DELETE ON core.history_registry
 FOR EACH ROW EXECUTE FUNCTION core.history_family_domain_changed();
CREATE FUNCTION core.history_family_touch(p_route integer,p_account uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 -- Before erasure there is no issuer or aggregate to invalidate.
 IF EXISTS(SELECT 1 FROM access.erasure WHERE route=p_route AND account_id=p_account) THEN
  INSERT INTO core.history_family_fence(account_route,account_id) VALUES(p_route,p_account)
   ON CONFLICT(account_route,account_id) DO UPDATE SET revision=core.history_family_fence.revision+1;
  UPDATE core.history_family_coverage SET phase='scan',gap=NULL,proof_id=NULL,next_run=now()
   WHERE account_route=p_route AND account_id=p_account;
 END IF;
END; $$;
CREATE FUNCTION core.history_family_touch_artifact(p_partition integer,p_type text,p_locator bytea) RETURNS void LANGUAGE plpgsql AS $$
DECLARE r record; n integer:=0;
BEGIN
 FOR r IN SELECT account_route,account_id FROM core.history_locator
  WHERE partition_no=p_partition AND artifact_type=p_type AND locator=p_locator
  ORDER BY account_route,account_id LIMIT 65
 LOOP
  n:=n+1;
  IF n>64 THEN RAISE EXCEPTION 'history role union exceeds native bound' USING ERRCODE='23514'; END IF;
  PERFORM core.history_family_touch(r.account_route,r.account_id);
 END LOOP;
END; $$;
CREATE FUNCTION core.history_family_scope_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND OLD IS NOT DISTINCT FROM NEW THEN RETURN NULL; END IF;
 IF TG_OP<>'INSERT' THEN PERFORM core.history_family_touch(OLD.account_route,OLD.account_id); END IF;
 IF TG_OP='INSERT' OR (TG_OP='UPDATE' AND (NEW.account_route,NEW.account_id) IS DISTINCT FROM (OLD.account_route,OLD.account_id)) THEN
  PERFORM core.history_family_touch(NEW.account_route,NEW.account_id);
 END IF;
 IF TG_TABLE_NAME IN ('history_locator','history_receiving_proof') THEN
  IF TG_OP<>'INSERT' THEN
   PERFORM core.history_family_touch_artifact(OLD.partition_no,OLD.artifact_type,OLD.locator);
  END IF;
  IF TG_OP<>'DELETE' THEN
   PERFORM core.history_family_touch_artifact(NEW.partition_no,NEW.artifact_type,NEW.locator);
  END IF;
 END IF;
 RETURN NULL;
END; $$;
CREATE TRIGGER history_family_locator_changed AFTER INSERT OR UPDATE OR DELETE ON core.history_locator
 FOR EACH ROW EXECUTE FUNCTION core.history_family_scope_changed();
CREATE TRIGGER history_family_receiving_changed AFTER INSERT ON core.history_receiving_proof
 FOR EACH ROW EXECUTE FUNCTION core.history_family_scope_changed();
CREATE TRIGGER history_family_enrollment_changed AFTER INSERT OR UPDATE OR DELETE ON core.history_family_enrollment
 FOR EACH ROW EXECUTE FUNCTION core.history_family_scope_changed();
CREATE TRIGGER history_family_seal_changed AFTER INSERT OR UPDATE OR DELETE ON core.history_seal
 FOR EACH ROW EXECUTE FUNCTION core.history_family_scope_changed();
CREATE FUNCTION core.history_family_physical_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE k jsonb; t text; r record;
BEGIN
 IF TG_TABLE_NAME='receipt' THEN
  t:='command-receipt/v1'; k:=jsonb_build_array(OLD.principal_kind,OLD.principal_id,OLD.command_kind,OLD.idempotency_key);
 ELSIF TG_TABLE_NAME='outbox' THEN
  t:='outbox-event/v1'; k:=jsonb_build_array(OLD.position::text,OLD.event_seq);
 ELSE
  t:='durable-work/v1'; k:=jsonb_build_array(OLD.work_id);
 END IF;
 FOR r IN SELECT l.account_route,l.account_id FROM core.history_family_watch w
   JOIN core.history_locator l USING(partition_no,artifact_type,locator)
   WHERE w.partition_no=OLD.partition_no AND w.artifact_type=t AND w.source_key=k
   ORDER BY l.account_route,l.account_id LIMIT 65
 LOOP PERFORM core.history_family_touch(r.account_route,r.account_id); END LOOP;
 RETURN NULL;
END; $$;
CREATE TRIGGER history_family_receipt_changed AFTER UPDATE OR DELETE ON core.receipt
 FOR EACH ROW EXECUTE FUNCTION core.history_family_physical_changed();
CREATE TRIGGER history_family_outbox_changed AFTER UPDATE OR DELETE ON core.outbox
 FOR EACH ROW EXECUTE FUNCTION core.history_family_physical_changed();
CREATE TRIGGER history_family_work_changed AFTER UPDATE OR DELETE ON core.history_work
 FOR EACH ROW EXECUTE FUNCTION core.history_family_physical_changed();
CREATE FUNCTION core.history_family_consumer_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r record; p integer; k bytea;
BEGIN
 IF TG_OP='DELETE' THEN
  p:=OLD.partition_no; k:=decode('0102','hex')||int2send(p::smallint)||int8send(OLD.position)||int2send(OLD.event_seq::smallint);
 ELSE
  p:=NEW.partition_no; k:=decode('0102','hex')||int2send(p::smallint)||int8send(NEW.position)||int2send(NEW.event_seq::smallint);
 END IF;
 FOR r IN SELECT account_route,account_id FROM core.history_locator
  WHERE partition_no=p AND artifact_type='outbox-event/v1' AND locator=k
  ORDER BY account_route,account_id LIMIT 65
 LOOP PERFORM core.history_family_touch(r.account_route,r.account_id); END LOOP;
 RETURN NULL;
END; $$;
CREATE TRIGGER history_family_consumer_changed AFTER INSERT OR UPDATE OR DELETE ON core.history_event_consumer
 FOR EACH ROW EXECUTE FUNCTION core.history_family_consumer_changed();
-- Enrollment is replaceable only by invalidating the account fence. The worker still checks
-- every version, original root and native seal; no source marker directly issues a capability.
CREATE TRIGGER history_family_watch_immutable BEFORE UPDATE OR DELETE ON core.history_family_watch
 FOR EACH ROW EXECUTE FUNCTION core.history_receiving_proof_immutable();
CREATE INDEX history_family_stale ON core.history_family_coverage(domain_generation,family,account_route,account_id) WHERE phase<>'scan';
CREATE FUNCTION core.history_family_validate_enrollment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e record; s record; d record; h record;
BEGIN
 SELECT version,at::text INTO STRICT e FROM access.erasure
  WHERE route=NEW.account_route AND account_id=NEW.account_id FOR SHARE;
 SELECT phase,barrier_id INTO STRICT s FROM core.history_seal WHERE partition_no=NEW.partition_no
  AND account_route=NEW.account_route AND account_id=NEW.account_id FOR SHARE;
 SELECT digest,sources INTO STRICT d FROM core.history_family_definition WHERE family=NEW.family FOR SHARE;
 SELECT epoch,write_state INTO STRICT h FROM core.partition WHERE partition_no=NEW.partition_no FOR SHARE;
 IF h.epoch<>NEW.partition_epoch OR h.write_state<>'active' OR e.version<>NEW.barrier_version OR e.at<>NEW.barrier_at OR s.phase='open' OR s.barrier_id<>NEW.account_id
   OR d.digest<>NEW.definition_digest OR NOT EXISTS(
     SELECT 1 FROM jsonb_to_recordset(d.sources) AS p("artifactType" text,producer text,version integer)
     WHERE p."artifactType"=NEW.artifact_type AND p.producer=NEW.producer AND p.version=NEW.producer_version)
 THEN RAISE EXCEPTION 'history family enrollment does not match native source' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER history_family_validate_enrollment BEFORE INSERT OR UPDATE ON core.history_family_enrollment
 FOR EACH ROW EXECUTE FUNCTION core.history_family_validate_enrollment();
CREATE FUNCTION core.history_family_preserve_locator() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE sealed boolean;
BEGIN
 SELECT phase<>'open' INTO sealed FROM core.history_seal WHERE partition_no=OLD.partition_no
  AND account_route=OLD.account_route AND account_id=OLD.account_id FOR SHARE;
 IF TG_OP='DELETE' THEN
  IF sealed OR OLD.state='minimized' THEN
   RAISE EXCEPTION 'sealed history role is irreversible' USING ERRCODE='23514';
  END IF;
  RETURN OLD;
 END IF;
 IF (sealed AND (OLD.partition_no,OLD.account_route,OLD.account_id,OLD.artifact_type,OLD.locator,OLD.roles,OLD.minimizer_version)
   IS DISTINCT FROM (NEW.partition_no,NEW.account_route,NEW.account_id,NEW.artifact_type,NEW.locator,NEW.roles,NEW.minimizer_version))
   OR (OLD.state='minimized' AND (NEW.state<>'minimized' OR NEW.proof_barrier IS DISTINCT FROM OLD.proof_barrier))
 THEN RAISE EXCEPTION 'sealed history role is irreversible' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER history_family_preserve_locator BEFORE UPDATE OR DELETE ON core.history_locator
 FOR EACH ROW EXECUTE FUNCTION core.history_family_preserve_locator();
CREATE FUNCTION core.history_family_admit(p_family text,p_route integer,p_account uuid) RETURNS void LANGUAGE sql AS $$
 INSERT INTO core.history_family_fence(account_route,account_id) VALUES(p_route,p_account) ON CONFLICT DO NOTHING;
 INSERT INTO core.history_family_coverage(family,account_route,account_id,barrier_version,barrier_at,
   definition_digest,domain_generation,fence_revision)
 SELECT p_family,e.route,e.account_id,e.version,e.at::text,d.digest,g.generation,f.revision
 FROM access.erasure e,core.history_family_definition d,core.history_family_domain g,core.history_family_fence f
 WHERE e.route=p_route AND e.account_id=p_account AND d.family=p_family AND g.singleton
  AND f.account_route=e.route AND f.account_id=e.account_id ON CONFLICT DO NOTHING;
$$;
CREATE FUNCTION core.history_family_job_admitted() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d record;
BEGIN
 FOR d IN SELECT family FROM core.history_family_definition ORDER BY family LIMIT 9
 LOOP PERFORM core.history_family_admit(d.family,NEW.account_route,NEW.account_id); END LOOP;
 RETURN NULL;
END; $$;
CREATE TRIGGER history_family_job_admitted AFTER INSERT ON core.preference_history_job
 FOR EACH ROW EXECUTE FUNCTION core.history_family_job_admitted();
-- migrate:down
-- Forward only: durable native coverage and writer fences cannot be silently removed.
