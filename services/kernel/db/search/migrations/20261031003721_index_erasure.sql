-- migrate:up
ALTER TABLE search.erasure_progress DROP CONSTRAINT erasure_progress_pending_reason_check;
ALTER TABLE search.erasure_progress ADD COLUMN frontier text CHECK (octet_length(frontier)<=2048),
  ADD COLUMN source_complete boolean NOT NULL DEFAULT false,
  ADD COLUMN personal_complete boolean NOT NULL DEFAULT false,
  ADD COLUMN acked boolean NOT NULL DEFAULT false,
  ADD COLUMN revision bigint NOT NULL DEFAULT 1;
-- These are native copy-generation counters, not account/source coverage.
ALTER TABLE search.public_filter_target ADD COLUMN copy_revision bigint NOT NULL DEFAULT 1;
CREATE INDEX public_filter_target_physical ON search.public_filter_target(physical_target,partition_no);
CREATE TABLE search.erasure_target (
  partition_no integer NOT NULL,
  account_id uuid NOT NULL,
  copy_home integer NOT NULL CHECK (copy_home BETWEEN 0 AND 4095),
  physical_target text COLLATE "C" NOT NULL,
  incarnation text COLLATE "C" NOT NULL,
  copy_revision bigint NOT NULL,
  registration_after text COLLATE "C",
  copies_complete boolean NOT NULL DEFAULT false,
  PRIMARY KEY(partition_no,account_id,copy_home,physical_target,incarnation)
);
CREATE TABLE search.erasure_effect (
  partition_no integer NOT NULL,
  account_id uuid NOT NULL,
  physical_target text COLLATE "C" NOT NULL,
  incarnation text COLLATE "C" NOT NULL,
  job uuid NOT NULL DEFAULT gen_random_uuid(),
  source_basis text NOT NULL CHECK (octet_length(source_basis)<=4096),
  consumer jsonb NOT NULL CHECK (octet_length(consumer::text)<=8192),
  barrier jsonb NOT NULL CHECK (octet_length(barrier::text)<=4096),
  native_revision text NOT NULL,
  record_key text CHECK (octet_length(record_key)<=4096),
  key_offset integer NOT NULL DEFAULT 0 CHECK (key_offset>=0),
  fence text CHECK (octet_length(fence)<=4096),
  phase text NOT NULL DEFAULT 'repair' CHECK (phase IN ('repair','fence','drain','adopt','compact','settled','released')),
  PRIMARY KEY(partition_no,account_id,physical_target,incarnation),
  UNIQUE(job)
);
-- Copy producers enroll atomically, including captures of excluded/empty populations. Deletes do not
-- advance admission; the eraser's own bounded cleanup must not manufacture a perpetually dirty head.
CREATE FUNCTION search.enroll_retained_copy() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_name text;
BEGIN
  IF TG_TABLE_NAME='public_filter_registration' THEN
    target_name := NEW.physical_target;
  ELSE
    SELECT physical_target INTO target_name FROM search.public_filter_registration
      WHERE (partition_no,id)=(NEW.partition_no,NEW.registration);
  END IF;
  PERFORM pg_advisory_xact_lock_shared(hashtextextended(target_name,741));
  IF EXISTS(SELECT 1 FROM search.identity_writer_gate
    WHERE partition_no=0 AND physical_target=target_name AND publication_fence IS NOT NULL) THEN
    RAISE EXCEPTION 'Search generation is fenced for native publication';
  END IF;
  IF TG_TABLE_NAME='public_filter_registration' THEN
    UPDATE search.public_filter_target SET copy_revision=copy_revision+1
      WHERE partition_no=NEW.partition_no AND physical_target=NEW.physical_target;
  ELSE
    UPDATE search.public_filter_target t SET copy_revision=t.copy_revision+1
      FROM search.public_filter_registration r
      WHERE (r.partition_no,r.id)=(NEW.partition_no,NEW.registration)
        AND (t.partition_no,t.physical_target)=(r.partition_no,r.physical_target);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER erasure_enroll_registration AFTER INSERT ON search.public_filter_registration
  FOR EACH ROW EXECUTE FUNCTION search.enroll_retained_copy();
CREATE TRIGGER erasure_enroll_observation AFTER INSERT ON search.public_filter_observation
  FOR EACH ROW EXECUTE FUNCTION search.enroll_retained_copy();
CREATE TRIGGER erasure_enroll_prepared AFTER INSERT ON search.public_filter_prepared
  FOR EACH ROW EXECUTE FUNCTION search.enroll_retained_copy();
-- migrate:down
-- Forward only: retain enrollment, pending native effects and replay skeletons.
