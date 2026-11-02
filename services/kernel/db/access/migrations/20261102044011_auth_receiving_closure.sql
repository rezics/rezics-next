-- migrate:up
-- Independent Source-home receiving control. Installation creates no physical
-- identity and backfills no historical Auth publication. Only the original
-- physical owner can populate installation/custody references; that owner ABI
-- is not installed by this migration or exposed as a service setter.
CREATE TABLE access.auth_receiving_control (
 partition_no integer PRIMARY KEY REFERENCES access.auth_erasure_source,
 source_generation uuid NOT NULL,
 source_epoch integer NOT NULL,
 source_owner text NOT NULL,
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
 state text NOT NULL DEFAULT 'owner-unavailable' CHECK(state IN ('owner-unavailable','active','quarantined')),
 requested_restore text CHECK(octet_length(requested_restore) BETWEEN 1 AND 1024),
 database_identity text CHECK(octet_length(database_identity) BETWEEN 1 AND 256),
 receiving_incarnation text CHECK(octet_length(receiving_incarnation) BETWEEN 1 AND 256),
 restore_generation text CHECK(octet_length(restore_generation) BETWEEN 1 AND 256),
 owner_installation text CHECK(octet_length(owner_installation) BETWEEN 1 AND 256),
 writer_fence text CHECK(octet_length(writer_fence) BETWEEN 1 AND 256),
 CHECK(state<>'active' OR (database_identity IS NOT NULL AND receiving_incarnation IS NOT NULL
  AND restore_generation IS NOT NULL AND owner_installation IS NOT NULL AND writer_fence IS NOT NULL
  AND (requested_restore IS NULL OR requested_restore=restore_generation)))
);
CREATE TABLE access.auth_receiving_obligation (
 route integer NOT NULL,
 account_id uuid NOT NULL,
 version integer NOT NULL CHECK(version>0),
 at timestamptz NOT NULL,
 partition_no integer NOT NULL REFERENCES access.auth_receiving_control,
 -- These must be actual receiver-bound custody references. Registration leaves
 -- them unknown; SDK state, Source enrollment and local EOF cannot populate them.
 custody_revision bigint,
 physical_closure text CHECK(octet_length(physical_closure) BETWEEN 1 AND 256),
 receiving_closure text CHECK(octet_length(receiving_closure) BETWEEN 1 AND 256),
 PRIMARY KEY(route,account_id),
 FOREIGN KEY(route,account_id) REFERENCES access.erasure(route,account_id),
 CHECK(partition_no=route/16),
 CHECK((custody_revision IS NULL AND physical_closure IS NULL AND receiving_closure IS NULL)
  OR (custody_revision>0 AND physical_closure IS NOT NULL AND receiving_closure IS NOT NULL))
);
CREATE TABLE access.auth_receiving_closure (
 route integer NOT NULL,
 account_id uuid NOT NULL,
 control_revision bigint NOT NULL,
 version integer NOT NULL,
 at timestamptz NOT NULL,
 native_obligation_id bigint NOT NULL CHECK(native_obligation_id>0),
 closure_receipt_id uuid NOT NULL,
 physical_closure text NOT NULL,
 receiving_closure text NOT NULL,
 published_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),
 PRIMARY KEY(route,account_id,control_revision),
 FOREIGN KEY(route,account_id) REFERENCES access.auth_receiving_obligation
);
CREATE TRIGGER auth_receiving_closure_immutable BEFORE UPDATE OR DELETE ON access.auth_receiving_closure
 FOR EACH ROW EXECUTE FUNCTION access.auth_erasure_immutable();
CREATE FUNCTION access.auth_receiving_control_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Auth receiving control is permanent'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.state<>'owner-unavailable' OR NEW.revision<>1 OR NEW.database_identity IS NOT NULL
    OR NEW.receiving_incarnation IS NOT NULL OR NEW.restore_generation IS NOT NULL
    OR NEW.owner_installation IS NOT NULL OR NEW.writer_fence IS NOT NULL THEN
   RAISE EXCEPTION 'Auth receiving registration cannot install physical ownership';
  END IF;
 ELSE
  IF (NEW.partition_no,NEW.source_generation,NEW.source_epoch,NEW.source_owner)
    IS DISTINCT FROM (OLD.partition_no,OLD.source_generation,OLD.source_epoch,OLD.source_owner)
    OR NEW.revision<>OLD.revision+1 THEN
   RAISE EXCEPTION 'Auth receiving transition must preserve Source and advance its fence';
  END IF;
  -- No original physical-owner installation ABI exists here. Invalidation is
  -- implemented; activation must be integrated by the original owner, replacing
  -- this refusal with its genuine owner-record validation, never a session flag.
  IF NEW.state='active' THEN
   RAISE EXCEPTION 'Auth original physical-owner installation unavailable';
  END IF;
  IF (NEW.database_identity,NEW.receiving_incarnation,NEW.restore_generation,NEW.owner_installation,NEW.writer_fence)
   IS DISTINCT FROM (OLD.database_identity,OLD.receiving_incarnation,OLD.restore_generation,OLD.owner_installation,OLD.writer_fence) THEN
   RAISE EXCEPTION 'Auth invalidation cannot install physical ownership';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER auth_receiving_control_guard BEFORE INSERT OR UPDATE OR DELETE ON access.auth_receiving_control
 FOR EACH ROW EXECUTE FUNCTION access.auth_receiving_control_guard();
CREATE FUNCTION access.auth_receiving_obligation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Auth receiving obligation is permanent'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.custody_revision IS NOT NULL OR NEW.physical_closure IS NOT NULL OR NEW.receiving_closure IS NOT NULL THEN
   RAISE EXCEPTION 'Auth receiving registration cannot assert physical custody';
  END IF;
 ELSE
  IF (NEW.route,NEW.account_id,NEW.version,NEW.at,NEW.partition_no)
   IS DISTINCT FROM (OLD.route,OLD.account_id,OLD.version,OLD.at,OLD.partition_no) THEN
   RAISE EXCEPTION 'Auth receiving obligation root is immutable';
  END IF;
  IF (NEW.custody_revision,NEW.physical_closure,NEW.receiving_closure)
   IS DISTINCT FROM (OLD.custody_revision,OLD.physical_closure,OLD.receiving_closure) THEN
   RAISE EXCEPTION 'Auth original physical receiving custody operation unavailable';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER auth_receiving_obligation_guard BEFORE INSERT OR UPDATE OR DELETE ON access.auth_receiving_obligation
 FOR EACH ROW EXECUTE FUNCTION access.auth_receiving_obligation_guard();
-- migrate:down
-- Forward only: receiving control and historical closure receipts are permanent.
