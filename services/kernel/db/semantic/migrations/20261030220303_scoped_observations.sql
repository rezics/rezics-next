-- migrate:up
-- Source-owned structural metadata. All relationships are home-local; remote values are locators.
CREATE TABLE semantic.identity_scope_summary (
 partition_no integer NOT NULL CHECK(partition_no BETWEEN 0 AND 4095),
 source_key text NOT NULL,
 scope_id text NOT NULL CHECK(octet_length(scope_id) BETWEEN 1 AND 256),
 source jsonb NOT NULL CHECK(octet_length(source::text)<=4096),
 registration uuid NOT NULL DEFAULT gen_random_uuid(),
 capture_id uuid NOT NULL,
 capture jsonb NOT NULL CHECK(octet_length(capture::text)<=4096),
 state text NOT NULL DEFAULT 'capturing' CHECK(state IN ('capturing','enrolling','ready','repair','retiring','retired')),
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
 active integer NOT NULL DEFAULT 0 CHECK(active>=0),
 frontier jsonb,
 scan_complete boolean NOT NULL DEFAULT false,
 enrollment_home integer NOT NULL DEFAULT 0 CHECK(enrollment_home BETWEEN 0 AND 4096),
 PRIMARY KEY(partition_no,source_key,scope_id)
);
CREATE INDEX identity_scope_repair_pending ON semantic.identity_scope_summary(partition_no,source_key,scope_id)
 WHERE state IN ('capturing','enrolling','repair');
CREATE TABLE semantic.identity_scope_repair_cursor (
 partition_no integer PRIMARY KEY CHECK(partition_no BETWEEN 0 AND 4095),
 next_home integer NOT NULL DEFAULT 0 CHECK(next_home BETWEEN 0 AND 4095),
 source_key text NOT NULL DEFAULT '',
 scope_id text NOT NULL DEFAULT ''
);
INSERT INTO semantic.identity_scope_repair_cursor(partition_no) SELECT generate_series(0,4095);
CREATE TABLE semantic.identity_scope_forward (
 partition_no integer NOT NULL,
 source_key text NOT NULL,
 scope_id text NOT NULL,
 registration uuid NOT NULL,
 dependency text NOT NULL,
 original uuid,
 dependency_home integer,
 ticket jsonb,
 PRIMARY KEY(partition_no,source_key,scope_id,registration,dependency)
);
CREATE INDEX identity_scope_forward_unresolved ON semantic.identity_scope_forward
 (partition_no,source_key,scope_id,registration,dependency) WHERE ticket IS NULL;
CREATE INDEX identity_scope_pending_groups ON semantic.identity_epoch_group(partition_no,terminal)
 WHERE pending_job IS NOT NULL;
-- Enrollment and preparation lock the same row. A closed bridge never issues a new ticket.
CREATE TABLE semantic.identity_scope_bridge (
 partition_no integer NOT NULL,
 generation uuid NOT NULL,
 closed_job uuid,
 closed_epoch bigint,
 version bigint NOT NULL DEFAULT 1,
 seal_transaction uuid,
 CHECK((closed_job IS NULL)=(closed_epoch IS NULL)),
 PRIMARY KEY(partition_no,generation)
);
CREATE TABLE semantic.identity_scope_inverse (
 partition_no integer NOT NULL,
 generation uuid NOT NULL,
 original uuid NOT NULL,
 source_partition integer NOT NULL,
 source_key text NOT NULL,
 scope_id text NOT NULL,
 registration uuid NOT NULL,
 capture_id uuid NOT NULL,
 source jsonb NOT NULL CHECK(octet_length(source::text)<=4096),
 transaction_id uuid NOT NULL,
 PRIMARY KEY(partition_no,generation,original,source_partition,source_key,scope_id,registration)
);
CREATE TABLE semantic.identity_scope_attempt (
 partition_no integer NOT NULL,
 source_key text NOT NULL,
 scope_id text NOT NULL,
 registration uuid NOT NULL,
 job_id uuid NOT NULL,
 job_epoch bigint NOT NULL,
 attempt jsonb NOT NULL,
 state text NOT NULL CHECK(state IN ('active','finished','cancelled')),
 transaction_id uuid NOT NULL,
 revision bigint NOT NULL,
 PRIMARY KEY(partition_no,source_key,scope_id,registration,job_id,job_epoch)
);
CREATE TABLE semantic.identity_scope_prearm_receipt (
 partition_no integer NOT NULL,
 source_key text NOT NULL,
 scope_id text NOT NULL,
 registration uuid NOT NULL,
 job_id uuid NOT NULL,
 job_epoch bigint NOT NULL,
 directory_transaction uuid NOT NULL,
 page_id text NOT NULL,
 ordinal integer NOT NULL CHECK(ordinal>=0),
 disposition text NOT NULL CHECK(disposition IN ('unsafe','cancelled')),
 transaction_id uuid NOT NULL,
 PRIMARY KEY(partition_no,source_key,scope_id,registration,job_id,job_epoch,directory_transaction,page_id,ordinal,disposition)
);
CREATE TABLE semantic.identity_public_capture (
 partition_no integer NOT NULL,
 capture_id uuid NOT NULL,
 source_id text NOT NULL,
 source_epoch integer NOT NULL,
 configuration text NOT NULL,
 read_definition text NOT NULL,
 definition_digest text NOT NULL,
 home integer NOT NULL DEFAULT 0 CHECK(home BETWEEN 0 AND 4096),
 after_route integer,
 after_id uuid,
 version bigint NOT NULL DEFAULT 1,
 complete boolean NOT NULL DEFAULT false,
 transaction_id uuid,
 PRIMARY KEY(partition_no,capture_id)
);
CREATE TABLE semantic.identity_public_capture_key (
 partition_no integer NOT NULL,
 capture_id uuid NOT NULL,
 original uuid NOT NULL,
 PRIMARY KEY(partition_no,capture_id,original)
);
-- A home guard covers future creation as well as the finite captured population. It is enrolled
-- through the same bridge as explicit originals, never consulted as a page-time activity gate.
CREATE TABLE semantic.identity_public_capture_home (
 partition_no integer NOT NULL,
 capture_id uuid NOT NULL,
 home integer NOT NULL,
 owner_epoch integer NOT NULL,
 writer_revision bigint NOT NULL,
 complete boolean NOT NULL DEFAULT false,
 PRIMARY KEY(partition_no,capture_id,home)
);
CREATE TABLE semantic.identity_public_writer (
 partition_no integer PRIMARY KEY,
 revision bigint NOT NULL DEFAULT 1
);
CREATE TABLE semantic.identity_public_dirty (
 partition_no integer NOT NULL,
 original uuid NOT NULL,
 revision bigint NOT NULL,
 PRIMARY KEY(partition_no,original)
);
CREATE INDEX identity_public_dirty_revision ON semantic.identity_public_dirty(partition_no,revision,original);
CREATE FUNCTION semantic.capture_identity_public_writer() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE h integer; v bigint; o uuid;
BEGIN
 IF TG_OP='DELETE' THEN h:=OLD.route>>4; o:=OLD.subject_id;
 ELSE h:=NEW.route>>4; o:=NEW.subject_id; END IF;
 INSERT INTO semantic.identity_public_writer(partition_no) VALUES(h)
 ON CONFLICT(partition_no) DO UPDATE SET revision=semantic.identity_public_writer.revision+1
 RETURNING revision INTO v;
 INSERT INTO semantic.identity_public_dirty VALUES(h,o,v)
 ON CONFLICT(partition_no,original) DO UPDATE SET revision=excluded.revision;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
CREATE TRIGGER identity_public_writer AFTER INSERT OR UPDATE OR DELETE ON semantic.subject
 FOR EACH ROW EXECUTE FUNCTION semantic.capture_identity_public_writer();
-- Existing admission cannot silently bypass a newly enrolled Source. The admission owner closes
-- and seals these exact indexed bridges before its first claim; no fanout is performed here.
CREATE FUNCTION semantic.guard_identity_scope_claim() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b semantic.identity_scope_bridge;
BEGIN
 IF NEW.pending_job IS NULL OR (NEW.pending_job,NEW.pending_epoch) IS NOT DISTINCT FROM
 (OLD.pending_job,OLD.pending_epoch) THEN RETURN NEW; END IF;
 INSERT INTO semantic.identity_scope_bridge(partition_no,generation)
 VALUES(NEW.partition_no,'00000000-0000-0000-0000-000000000000') ON CONFLICT DO NOTHING;
 FOR b IN SELECT * FROM semantic.identity_scope_bridge
 WHERE partition_no=NEW.partition_no AND generation IN
 (NEW.generation,'00000000-0000-0000-0000-000000000000'::uuid)
 ORDER BY generation FOR UPDATE LOOP
  -- Advance even an empty prefix: later enrollment cannot miss a committed prior claim
  -- through a SERIALIZABLE snapshot taken before this bridge lock was available.
  UPDATE semantic.identity_scope_bridge SET version=version+1
  WHERE partition_no=b.partition_no AND generation=b.generation;
  IF NOT EXISTS(SELECT 1 FROM semantic.identity_scope_inverse i WHERE i.partition_no=b.partition_no AND i.generation=b.generation LIMIT 1) THEN CONTINUE; END IF;
  IF b.closed_job IS DISTINCT FROM NEW.pending_job OR b.closed_epoch IS DISTINCT FROM NEW.pending_epoch
   OR b.seal_transaction IS NULL THEN
   RAISE EXCEPTION 'identity_scope_prearm_required' USING ERRCODE='40001';
  END IF;
 END LOOP;
 RETURN NEW;
END $$;
CREATE TRIGGER identity_scope_claim BEFORE UPDATE OF pending_job,pending_epoch ON semantic.identity_epoch_group
 FOR EACH ROW EXECUTE FUNCTION semantic.guard_identity_scope_claim();
ALTER TABLE semantic.identity_epoch_native_commit DROP CONSTRAINT identity_epoch_native_commit_purpose_check;
ALTER TABLE semantic.identity_epoch_native_commit ADD CONSTRAINT identity_epoch_native_commit_purpose_check CHECK
 (purpose IN ('bootstrap','admission','mapping','search-canonical-index','library-private-follow-counts',
 'identity-receiving-plan','identity-receiving-record','identity-receiving-custody',
 'identity-prearm','identity-prearm-cancel',
 'identity-scope-registration','identity-scope-enrollment','identity-scope-preparation','identity-scope-cancellation','identity-public-capture'));
CREATE TABLE semantic.identity_public_capture_page (
 partition_no integer NOT NULL,
 capture_id uuid NOT NULL,
 page_version bigint NOT NULL,
 payload jsonb NOT NULL CHECK(octet_length(payload::text)<=4096),
 transaction_id uuid NOT NULL,
 PRIMARY KEY(partition_no,capture_id,page_version)
);

-- migrate:down
DROP TABLE semantic.identity_scope_repair_cursor;
DROP INDEX semantic.identity_scope_pending_groups;
DROP TRIGGER identity_scope_claim ON semantic.identity_epoch_group;
DROP FUNCTION semantic.guard_identity_scope_claim();
DROP TRIGGER identity_public_writer ON semantic.subject;
DROP FUNCTION semantic.capture_identity_public_writer();
DROP TABLE semantic.identity_public_capture_page;
DROP TABLE semantic.identity_public_dirty;
DROP TABLE semantic.identity_public_writer;
DROP TABLE semantic.identity_public_capture_home;
DROP TABLE semantic.identity_public_capture_key;
DROP TABLE semantic.identity_public_capture;
DROP TABLE semantic.identity_scope_prearm_receipt;
DROP TABLE semantic.identity_scope_attempt;
DROP TABLE semantic.identity_scope_inverse;
DROP TABLE semantic.identity_scope_bridge;
DROP TABLE semantic.identity_scope_forward;
DROP TABLE semantic.identity_scope_summary;
