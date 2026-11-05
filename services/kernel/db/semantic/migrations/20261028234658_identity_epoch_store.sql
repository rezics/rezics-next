-- migrate:up
-- This migration installs storage and change capture, NOT writer cutover or readiness.
CREATE TABLE semantic.identity_epoch_control (
  partition_no integer PRIMARY KEY CHECK (partition_no = 0),
  published_epoch bigint NOT NULL CHECK (published_epoch >= 0),
  pending_job uuid,
  pending_epoch bigint,
  CHECK ((pending_job IS NULL) = (pending_epoch IS NULL)),
  CHECK (pending_epoch IS NULL OR pending_epoch = published_epoch + 1)
);
INSERT INTO semantic.identity_epoch_control VALUES (0, 0, NULL, NULL);

CREATE TABLE semantic.identity_epoch_job (
  partition_no integer NOT NULL DEFAULT 0 CHECK (partition_no = 0),
  job_id uuid PRIMARY KEY,
  epoch bigint NOT NULL UNIQUE CHECK (epoch > 0),
  intent jsonb NOT NULL,
  receipt_key text NOT NULL UNIQUE,
  receipt jsonb NOT NULL,
  scope_digest text NOT NULL,
  state text NOT NULL CHECK (state IN ('pending','published')),
  recorded_transaction_id uuid NOT NULL
);
CREATE UNIQUE INDEX identity_epoch_one_pending ON semantic.identity_epoch_job ((state)) WHERE state='pending';
CREATE FUNCTION semantic.protect_identity_epoch_job() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Identity job intent and receipts are immutable' USING ERRCODE='23514'; END IF;
  IF (to_jsonb(NEW)-'state') IS DISTINCT FROM (to_jsonb(OLD)-'state') OR OLD.state='published' THEN
    RAISE EXCEPTION 'Identity job intent and receipts are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER identity_epoch_job_immutable BEFORE UPDATE OR DELETE ON semantic.identity_epoch_job
  FOR EACH ROW EXECUTE FUNCTION semantic.protect_identity_epoch_job();
CREATE TABLE semantic.identity_epoch_change (
  partition_no integer NOT NULL DEFAULT 0 CHECK (partition_no = 0),
  job_id uuid NOT NULL REFERENCES semantic.identity_epoch_job(job_id),
  original uuid NOT NULL,
  previous_terminal uuid NOT NULL,
  terminal uuid NOT NULL,
  PRIMARY KEY (job_id,original)
);
CREATE TRIGGER identity_epoch_change_immutable BEFORE UPDATE OR DELETE ON semantic.identity_epoch_change
  FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();
CREATE TRIGGER identity_epoch_change_immutable_truncate BEFORE TRUNCATE ON semantic.identity_epoch_change
  FOR EACH STATEMENT EXECUTE FUNCTION semantic.prevent_revision_mutation();

CREATE TABLE semantic.identity_epoch_mapping (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  original uuid NOT NULL,
  terminal uuid NOT NULL,
  epoch bigint NOT NULL CHECK (epoch >= 0),
  origin text NOT NULL CHECK (origin IN ('creation','published')),
  recorded_transaction_id uuid NOT NULL,
  PRIMARY KEY (route,original),
  FOREIGN KEY (route,original) REFERENCES semantic.subject(route,subject_id),
  CHECK (route = get_byte(uuid_send(original),10)*256 + get_byte(uuid_send(original),11))
);
-- A gate lives in the EFFECT destination home. It is retained through ACK custody.
CREATE TABLE semantic.identity_epoch_home_gate (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  destination uuid NOT NULL,
  original uuid NOT NULL,
  terminal uuid NOT NULL,
  epoch bigint NOT NULL CHECK (epoch >= 0),
  pending_job uuid,
  pending_epoch bigint,
  recorded_transaction_id uuid NOT NULL,
  PRIMARY KEY (route,destination,original),
  CHECK (route = get_byte(uuid_send(destination),10)*256 + get_byte(uuid_send(destination),11)),
  CHECK ((pending_job IS NULL) = (pending_epoch IS NULL))
);

-- Native records bind BOTH transaction identity and the command component. A position is not a receipt.
CREATE TABLE semantic.identity_epoch_native_commit (
  partition_no integer NOT NULL CHECK (partition_no BETWEEN 0 AND 4095),
  transaction_id uuid NOT NULL,
  epoch integer NOT NULL,
  position bigint NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('bootstrap','mapping','search-canonical-index','library-private-follow-counts')),
  PRIMARY KEY (partition_no,transaction_id),
  UNIQUE (partition_no,transaction_id,epoch,position)
);
CREATE TABLE semantic.identity_epoch_step (
  partition_no integer NOT NULL,
  transaction_id uuid NOT NULL,
  native_epoch integer NOT NULL,
  native_position bigint NOT NULL,
  job_id uuid NOT NULL,
  job_epoch bigint NOT NULL,
  step text NOT NULL CHECK (step IN ('mapping','search-canonical-index','library-private-follow-counts')),
  version integer NOT NULL CHECK (version=1),
  scope_digest text NOT NULL,
  frontier jsonb NOT NULL CHECK (octet_length(frontier::text)<=2048 AND jsonb_array_length(frontier->'after')<=8),
  state text NOT NULL CHECK (state IN ('more','complete')),
  work jsonb NOT NULL,
  PRIMARY KEY (partition_no,transaction_id,job_id,step),
  FOREIGN KEY (partition_no,transaction_id,native_epoch,native_position)
    REFERENCES semantic.identity_epoch_native_commit(partition_no,transaction_id,epoch,position)
);
CREATE TABLE semantic.identity_epoch_effect_receipt (
  partition_no integer NOT NULL DEFAULT 0 CHECK (partition_no=0),
  job_id uuid NOT NULL REFERENCES semantic.identity_epoch_job(job_id),
  step text NOT NULL CHECK (step IN ('mapping','search-canonical-index','library-private-follow-counts')),
  effect_key text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('remove','add','pending-fence','published-fence')),
  native_partition integer,
  native_epoch integer,
  native_position bigint,
  native_transaction_id uuid,
  PRIMARY KEY (job_id,step,effect_key),
  CHECK ((native_transaction_id IS NULL) = (native_partition IS NULL)),
  CHECK ((native_transaction_id IS NULL) = (native_epoch IS NULL)),
  CHECK ((native_transaction_id IS NULL) = (native_position IS NULL))
);
CREATE TABLE semantic.identity_epoch_ack (
  partition_no integer NOT NULL DEFAULT 0 CHECK (partition_no=0),
  job_id uuid NOT NULL REFERENCES semantic.identity_epoch_job(job_id),
  step text NOT NULL CHECK (step IN ('mapping','search-canonical-index','library-private-follow-counts')),
  version integer NOT NULL CHECK (version=1),
  scope_digest text NOT NULL,
  progress jsonb NOT NULL,
  native_partition integer NOT NULL,
  native_epoch integer NOT NULL,
  native_position bigint NOT NULL,
  native_transaction_id uuid NOT NULL,
  PRIMARY KEY (job_id,step)
);

-- Each source writer captures only local keys; no global vector, home scan, ordering claim or self mapping.
CREATE TABLE semantic.identity_epoch_dirty (
  route integer NOT NULL,
  original uuid NOT NULL,
  revision bigint NOT NULL DEFAULT 1,
  captured_revision bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (route,original),
  CHECK (revision >= captured_revision AND captured_revision >= 0)
);
CREATE INDEX identity_epoch_dirty_pending ON semantic.identity_epoch_dirty (route,original)
  WHERE revision > captured_revision;
CREATE TABLE semantic.identity_epoch_member_dirty (
  route integer NOT NULL,
  terminal uuid NOT NULL,
  original uuid NOT NULL,
  revision bigint NOT NULL DEFAULT 1,
  captured_revision bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (route,terminal,original),
  CHECK (revision >= captured_revision AND captured_revision >= 0)
);
CREATE INDEX identity_epoch_member_dirty_pending ON semantic.identity_epoch_member_dirty (route,terminal,original)
  WHERE revision > captured_revision;
CREATE FUNCTION semantic.capture_identity_epoch_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r integer; id uuid;
BEGIN
  IF TG_OP='DELETE' THEN r=OLD.route; id=OLD.subject_id;
  ELSE r=NEW.route; id=NEW.subject_id; END IF;
  IF TG_TABLE_NAME='merge_member' THEN
    INSERT INTO semantic.identity_epoch_member_dirty(route,terminal,original)
    VALUES (r,id,CASE WHEN TG_OP='DELETE' THEN OLD.member_id ELSE NEW.member_id END)
    ON CONFLICT (route,terminal,original) DO UPDATE SET revision=semantic.identity_epoch_member_dirty.revision+1;
    IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  INSERT INTO semantic.identity_epoch_dirty(route,original) VALUES (r,id)
  ON CONFLICT (route,original) DO UPDATE SET revision=semantic.identity_epoch_dirty.revision+1;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END; $$;
CREATE TRIGGER identity_epoch_capture_subject AFTER INSERT OR DELETE ON semantic.subject
  FOR EACH ROW EXECUTE FUNCTION semantic.capture_identity_epoch_source();
CREATE TRIGGER identity_epoch_capture_redirect AFTER INSERT OR DELETE OR UPDATE ON semantic.redirect
  FOR EACH ROW EXECUTE FUNCTION semantic.capture_identity_epoch_source();
CREATE TRIGGER identity_epoch_capture_member AFTER INSERT OR DELETE OR UPDATE ON semantic.merge_member
  FOR EACH ROW EXECUTE FUNCTION semantic.capture_identity_epoch_source();

CREATE TABLE semantic.identity_epoch_bootstrap_home (
  partition_no integer PRIMARY KEY CHECK (partition_no BETWEEN 0 AND 4095),
  phase text NOT NULL CHECK (phase IN ('subjects','members','dirty','member-dirty')),
  after_route integer NOT NULL,
  after_original uuid NOT NULL,
  after_member uuid NOT NULL,
  generation bigint NOT NULL DEFAULT 0
);
CREATE TABLE semantic.identity_epoch_bootstrap_page (
  partition_no integer NOT NULL,
  transaction_id uuid NOT NULL,
  generation bigint NOT NULL,
  phase text NOT NULL CHECK (phase IN ('subjects','members','dirty','member-dirty')),
  PRIMARY KEY (partition_no,transaction_id),
  UNIQUE (partition_no,generation),
  FOREIGN KEY (partition_no,transaction_id) REFERENCES semantic.identity_epoch_native_commit(partition_no,transaction_id)
);
CREATE TABLE semantic.identity_epoch_bootstrap_row (
  partition_no integer NOT NULL,
  transaction_id uuid NOT NULL,
  route integer NOT NULL,
  original uuid NOT NULL,
  terminal uuid NOT NULL,
  source_revision bigint NOT NULL,
  present boolean NOT NULL,
  PRIMARY KEY (partition_no,transaction_id,original,terminal),
  FOREIGN KEY (partition_no,transaction_id) REFERENCES semantic.identity_epoch_bootstrap_page(partition_no,transaction_id)
);
-- These counts describe OBSERVED input. They are never complete cardinality/admission authority before cutover.
CREATE TABLE semantic.identity_epoch_original (
  partition_no integer NOT NULL DEFAULT 0 CHECK (partition_no=0),
  original uuid PRIMARY KEY,
  terminal uuid NOT NULL,
  source_partition integer NOT NULL,
  source_generation bigint NOT NULL,
  present boolean NOT NULL
);
CREATE INDEX identity_epoch_original_group ON semantic.identity_epoch_original (terminal,original) WHERE present;
CREATE TABLE semantic.identity_epoch_group (
  partition_no integer NOT NULL DEFAULT 0 CHECK (partition_no=0),
  terminal uuid PRIMARY KEY,
  observed_count bigint NOT NULL CHECK (observed_count>=0)
);
CREATE TABLE semantic.identity_epoch_legacy_member (
  partition_no integer NOT NULL DEFAULT 0 CHECK (partition_no=0),
  terminal uuid NOT NULL,
  original uuid NOT NULL,
  source_partition integer NOT NULL,
  source_generation bigint NOT NULL,
  PRIMARY KEY (terminal,original)
);
CREATE TABLE semantic.identity_epoch_bootstrap_custody (
  partition_no integer NOT NULL DEFAULT 0 CHECK (partition_no=0),
  source_partition integer NOT NULL,
  source_generation bigint NOT NULL,
  native_transaction_id uuid NOT NULL,
  native_epoch integer NOT NULL,
  native_position bigint NOT NULL,
  PRIMARY KEY (source_partition,source_generation)
);
CREATE TRIGGER identity_epoch_native_commit_immutable BEFORE UPDATE OR DELETE ON semantic.identity_epoch_native_commit
  FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();
CREATE TRIGGER identity_epoch_step_immutable BEFORE UPDATE OR DELETE ON semantic.identity_epoch_step
  FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();
CREATE TRIGGER identity_epoch_bootstrap_page_immutable BEFORE UPDATE OR DELETE ON semantic.identity_epoch_bootstrap_page
  FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();
CREATE TRIGGER identity_epoch_bootstrap_row_immutable BEFORE UPDATE OR DELETE ON semantic.identity_epoch_bootstrap_row
  FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();
CREATE TRIGGER identity_epoch_bootstrap_custody_immutable BEFORE UPDATE OR DELETE ON semantic.identity_epoch_bootstrap_custody
  FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();

-- migrate:down
DROP TABLE semantic.identity_epoch_bootstrap_custody;
DROP TABLE semantic.identity_epoch_legacy_member;
DROP TABLE semantic.identity_epoch_group;
DROP TABLE semantic.identity_epoch_original;
DROP TABLE semantic.identity_epoch_bootstrap_row;
DROP TABLE semantic.identity_epoch_bootstrap_page;
DROP TABLE semantic.identity_epoch_bootstrap_home;
DROP TRIGGER identity_epoch_capture_member ON semantic.merge_member;
DROP TRIGGER identity_epoch_capture_redirect ON semantic.redirect;
DROP TRIGGER identity_epoch_capture_subject ON semantic.subject;
DROP FUNCTION semantic.capture_identity_epoch_source();
DROP TABLE semantic.identity_epoch_member_dirty;
DROP TABLE semantic.identity_epoch_dirty;
DROP TABLE semantic.identity_epoch_ack;
DROP TABLE semantic.identity_epoch_effect_receipt;
DROP TABLE semantic.identity_epoch_step;
DROP TABLE semantic.identity_epoch_native_commit;
DROP TABLE semantic.identity_epoch_home_gate;
DROP TABLE semantic.identity_epoch_mapping;
DROP TABLE semantic.identity_epoch_change;
DROP TABLE semantic.identity_epoch_job;
DROP FUNCTION semantic.protect_identity_epoch_job();
DROP TABLE semantic.identity_epoch_control;
