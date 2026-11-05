-- migrate:up
-- Freeze the installed enrollment set while excluding both enrollment and
-- captured-window changes. Zero identifies this installation snapshot only; it
-- is not a Source position, Account revision, claim revision or coverage ACK.
LOCK TABLE semantic.public_filter_privacy_head,
  semantic.public_filter_privacy_pending,
  semantic.public_filter_key_enrollment IN ACCESS EXCLUSIVE MODE;

ALTER TABLE semantic.public_filter_privacy_head
  ADD COLUMN enrollment_generation bigint NOT NULL DEFAULT 0 CHECK (enrollment_generation >= 0);
ALTER TABLE semantic.public_filter_key_enrollment
  ADD COLUMN enrollment_generation bigint NOT NULL DEFAULT 0 CHECK (enrollment_generation >= 0);
ALTER TABLE semantic.public_filter_key_enrollment
  ALTER COLUMN enrollment_generation DROP DEFAULT;
ALTER TABLE semantic.public_filter_privacy_pending
  ADD COLUMN captured_enrollment_generation bigint CHECK (captured_enrollment_generation >= 0);
UPDATE semantic.public_filter_privacy_pending SET captured_enrollment_generation=0
  WHERE coalesce(native_captured_enqueue,captured_revision) IS NOT NULL;
ALTER TABLE semantic.public_filter_privacy_pending
  ADD CONSTRAINT public_filter_pending_enrollment_window CHECK
    ((coalesce(native_captured_enqueue,captured_revision) IS NULL) =
      (captured_enrollment_generation IS NULL));

CREATE INDEX public_filter_key_enrollment_window
  ON semantic.public_filter_key_enrollment
  (partition_no,input_key,enrollment_generation,registration_partition,registration,bootstrap);

CREATE FUNCTION semantic.retain_public_filter_enrollment_window() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.captured_enrollment_generation IS NOT NULL
    AND coalesce(NEW.native_captured_enqueue,NEW.captured_revision) IS NOT NULL
    AND NEW.captured_enrollment_generation IS DISTINCT FROM OLD.captured_enrollment_generation THEN
    RAISE EXCEPTION 'Original Source enrollment window is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER public_filter_enrollment_window_immutable
  BEFORE UPDATE ON semantic.public_filter_privacy_pending
  FOR EACH ROW EXECUTE FUNCTION semantic.retain_public_filter_enrollment_window();

CREATE FUNCTION semantic.retain_public_filter_key_generation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.enrollment_generation IS DISTINCT FROM OLD.enrollment_generation THEN
    RAISE EXCEPTION 'Original Source key enrollment generation is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER public_filter_key_generation_immutable
  BEFORE UPDATE ON semantic.public_filter_key_enrollment
  FOR EACH ROW EXECUTE FUNCTION semantic.retain_public_filter_key_generation();

-- migrate:down
DO $$ BEGIN
  RAISE EXCEPTION 'Retained Source enrollment windows require original Source retirement';
END $$;
