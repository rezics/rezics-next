-- migrate:up
ALTER TABLE semantic.identity_epoch_job DROP CONSTRAINT identity_epoch_job_state_check;
ALTER TABLE semantic.identity_epoch_job ADD CHECK(state IN ('preparing','pending','cancelling','cancelled','published'));
DROP INDEX semantic.identity_epoch_one_pending;
CREATE UNIQUE INDEX identity_epoch_one_pending ON semantic.identity_epoch_job(partition_no)
  WHERE state IN ('preparing','pending','cancelling');
ALTER TABLE semantic.identity_epoch_native_commit DROP CONSTRAINT identity_epoch_native_commit_purpose_check;
ALTER TABLE semantic.identity_epoch_native_commit ADD CHECK(purpose IN
  ('bootstrap','admission','mapping','search-canonical-index','library-private-follow-counts'));

ALTER TABLE semantic.identity_epoch_input ADD COLUMN control_partition integer;
ALTER TABLE semantic.identity_epoch_input ADD COLUMN owner_epoch integer;
UPDATE semantic.identity_epoch_input i SET control_partition=g.partition_no,owner_epoch=g.owner_epoch
  FROM semantic.identity_epoch_group g WHERE g.generation=i.generation;
ALTER TABLE semantic.identity_epoch_input ALTER COLUMN control_partition SET NOT NULL;

-- Constant source bases, not copies of a group. Every row belongs to the first resource home.
CREATE TABLE semantic.identity_epoch_admission_source (
  partition_no integer NOT NULL,
  job_id uuid NOT NULL REFERENCES semantic.identity_epoch_job(job_id),
  original uuid NOT NULL,
  route integer NOT NULL,
  control_partition integer NOT NULL,
  terminal uuid NOT NULL,
  generation uuid NOT NULL,
  basis_version bigint NOT NULL,
  source_revision bigint NOT NULL,
  source_transaction_id uuid NOT NULL,
  owner_epoch integer NOT NULL,
  source_owner_epoch integer NOT NULL,
  PRIMARY KEY(job_id,original)
);
CREATE TABLE semantic.identity_epoch_admission_plan (
  partition_no integer NOT NULL,
  job_id uuid NOT NULL REFERENCES semantic.identity_epoch_job(job_id),
  resource_home integer NOT NULL,
  acquired_transaction_id uuid,
  acquired_epoch integer,
  acquired_position bigint,
  closed_transaction_id uuid,
  closed_epoch integer,
  closed_position bigint,
  PRIMARY KEY(job_id,resource_home)
);
CREATE INDEX identity_epoch_preparing_home ON semantic.identity_epoch_job(partition_no)
  WHERE state IN ('preparing','cancelling');
-- First absence, acquire and close serialize on this native attempt key and the home control row.
-- A closed row is a rejected-attempt fence; it never occupies a capacity slot.
CREATE TABLE semantic.identity_epoch_admission_attempt (
  partition_no integer NOT NULL,
  job_id uuid NOT NULL,
  job_epoch bigint NOT NULL,
  scope_digest text NOT NULL,
  state text NOT NULL CHECK(state IN ('acquired','closed')),
  PRIMARY KEY(partition_no,job_id)
);
CREATE TABLE semantic.identity_epoch_admission_receipt (
  partition_no integer NOT NULL,
  transaction_id uuid NOT NULL,
  native_epoch integer NOT NULL,
  native_position bigint NOT NULL,
  job_id uuid NOT NULL,
  job_epoch bigint NOT NULL,
  scope_digest text NOT NULL,
  stage text NOT NULL CHECK(stage IN ('acquired','closed')),
  version integer NOT NULL CHECK(version=1),
  PRIMARY KEY(partition_no,job_id,stage),
  FOREIGN KEY(partition_no,transaction_id,native_epoch,native_position)
    REFERENCES semantic.identity_epoch_native_commit(partition_no,transaction_id,epoch,position)
);
CREATE TRIGGER identity_epoch_admission_receipt_immutable BEFORE UPDATE OR DELETE ON semantic.identity_epoch_admission_receipt
  FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();

-- Each invocation is inside the actual source-home runCommand. No foreign-home row is mutated.
CREATE FUNCTION semantic.acquire_identity_epoch_admission(p_home integer,p_job uuid,p_epoch bigint,p_scope text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE a semantic.identity_epoch_admission_attempt; c semantic.identity_epoch_control;
BEGIN
  SELECT * INTO c FROM semantic.identity_epoch_control WHERE partition_no=p_home FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'identity_epoch_unavailable'; END IF;
  SELECT * INTO a FROM semantic.identity_epoch_admission_attempt
    WHERE partition_no=p_home AND job_id=p_job FOR UPDATE;
  IF FOUND THEN
    IF a.state='closed' OR a.job_epoch<>p_epoch OR a.scope_digest<>p_scope THEN
      RAISE EXCEPTION 'identity_effect_stale';
    END IF;
    RETURN;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM semantic.identity_epoch_admission_plan
    WHERE job_id=p_job AND resource_home=p_home) THEN RAISE EXCEPTION 'identity_effect_stale'; END IF;
  PERFORM 1 FROM semantic.identity_epoch_group g JOIN semantic.identity_epoch_input i
    ON (i.control_partition,i.terminal)=(g.partition_no,g.terminal)
    WHERE i.job_id=p_job AND g.partition_no=p_home ORDER BY g.terminal FOR UPDATE OF g;
  IF EXISTS(SELECT 1 FROM semantic.identity_epoch_group g JOIN semantic.identity_epoch_input i
    ON (i.control_partition,i.terminal)=(g.partition_no,g.terminal)
    WHERE i.job_id=p_job AND g.partition_no=p_home AND g.pending_job IS NOT NULL AND g.pending_job<>p_job)
    THEN RAISE EXCEPTION 'identity_epoch_busy'; END IF;
  IF c.pending_job IS NOT NULL AND c.pending_job<>p_job THEN RAISE EXCEPTION 'identity_epoch_unavailable'; END IF;
  IF EXISTS(SELECT 1 FROM semantic.identity_epoch_input i LEFT JOIN semantic.identity_epoch_group g
    ON (g.partition_no,g.terminal,g.generation,g.version,g.owner_epoch)=
       (i.control_partition,i.terminal,i.generation,i.basis_version,i.owner_epoch)
    LEFT JOIN core.partition o ON o.partition_no=i.control_partition AND o.epoch=i.owner_epoch AND o.write_state='active'
    WHERE i.job_id=p_job AND i.control_partition=p_home AND (g.terminal IS NULL OR o.partition_no IS NULL))
    THEN RAISE EXCEPTION 'identity_effect_stale'; END IF;
  INSERT INTO semantic.identity_epoch_admission_attempt VALUES(p_home,p_job,p_epoch,p_scope,'acquired');
  UPDATE semantic.identity_epoch_group SET pending_job=p_job,pending_epoch=p_epoch
    WHERE partition_no=p_home AND terminal IN
      (SELECT terminal FROM semantic.identity_epoch_input WHERE job_id=p_job AND control_partition=p_home);
  UPDATE semantic.identity_epoch_control SET pending_job=p_job,pending_epoch=p_epoch,
    allocated_epoch=greatest(allocated_epoch,p_epoch) WHERE partition_no=p_home;
END; $$;

CREATE FUNCTION semantic.close_identity_epoch_admission(p_home integer,p_job uuid,p_epoch bigint,p_scope text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE a semantic.identity_epoch_admission_attempt;
BEGIN
  PERFORM 1 FROM semantic.identity_epoch_control WHERE partition_no=p_home FOR UPDATE;
  SELECT * INTO a FROM semantic.identity_epoch_admission_attempt
    WHERE partition_no=p_home AND job_id=p_job FOR UPDATE;
  IF FOUND AND (a.job_epoch<>p_epoch OR a.scope_digest<>p_scope) THEN RAISE EXCEPTION 'identity_effect_stale'; END IF;
  INSERT INTO semantic.identity_epoch_admission_attempt VALUES(p_home,p_job,p_epoch,p_scope,'closed')
    ON CONFLICT(partition_no,job_id) DO UPDATE SET state='closed';
  UPDATE semantic.identity_epoch_group SET pending_job=NULL,pending_epoch=NULL
    WHERE partition_no=p_home AND pending_job=p_job AND pending_epoch=p_epoch;
  UPDATE semantic.identity_epoch_control SET pending_job=NULL,pending_epoch=NULL
    WHERE partition_no=p_home AND pending_job=p_job AND pending_epoch=p_epoch;
END; $$;

-- migrate:down
-- Forward-only native attempt fences and custody.
