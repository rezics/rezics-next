-- migrate:up
-- Native verifier progress belongs to the original immutable repair pages. Payloads
-- remain immutable; a verified prefix can only acquire its exact next successor.
ALTER TABLE semantic.public_filter_repair_step
  ADD COLUMN verified_binding text CHECK (verified_binding ~ '^[0-9a-f]{64}$'),
  ADD COLUMN verified_root text CHECK (verified_root ~ '^[0-9a-f]{64}$'),
  ADD COLUMN verified_ordinal bigint CHECK (verified_ordinal > 0),
  ADD COLUMN verified_next uuid,
  ADD CONSTRAINT public_filter_repair_verified_fields CHECK
    ((verified_binding IS NULL) = (verified_root IS NULL) AND
     (verified_binding IS NULL) = (verified_ordinal IS NULL) AND
     (verified_next IS NULL OR verified_root IS NOT NULL)),
  ADD CONSTRAINT public_filter_repair_verified_successor FOREIGN KEY
    (partition_no,bootstrap,execution,verified_next)
    REFERENCES semantic.public_filter_repair_step(partition_no,bootstrap,execution,step);
CREATE UNIQUE INDEX public_filter_repair_verified_tip
  ON semantic.public_filter_repair_step (partition_no,bootstrap,execution)
  WHERE verified_root IS NOT NULL AND verified_next IS NULL;

CREATE FUNCTION semantic.retain_public_filter_repair_verification() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE parent semantic.public_filter_repair_step;
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Original public-filter repair pages are immutable' USING ERRCODE='23514';
  END IF;
  IF (NEW.partition_no,NEW.bootstrap,NEW.execution,NEW.step,NEW.predecessor,NEW.state,
      NEW.complete,NEW.input_limit,NEW.receipt_protocol,NEW.repair_locator_digests)
    IS DISTINCT FROM
     (OLD.partition_no,OLD.bootstrap,OLD.execution,OLD.step,OLD.predecessor,OLD.state,
      OLD.complete,OLD.input_limit,OLD.receipt_protocol,OLD.repair_locator_digests) OR
    (OLD.verified_root IS NOT NULL AND
      (NEW.verified_binding,NEW.verified_root,NEW.verified_ordinal)
      IS DISTINCT FROM (OLD.verified_binding,OLD.verified_root,OLD.verified_ordinal)) OR
    (OLD.verified_next IS NOT NULL AND NEW.verified_next IS DISTINCT FROM OLD.verified_next) OR
    (OLD.complete AND NEW.verified_next IS NOT NULL)
  THEN
    RAISE EXCEPTION 'Original public-filter repair evidence is immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.verified_root IS NOT NULL AND OLD.verified_root IS NULL THEN
    IF NEW.predecessor IS NULL THEN
      IF NEW.verified_ordinal<>1 THEN
        RAISE EXCEPTION 'Repair verification must begin at its original root' USING ERRCODE='23514';
      END IF;
    ELSE
      SELECT * INTO parent FROM semantic.public_filter_repair_step
      WHERE (partition_no,bootstrap,execution,step)=
        (NEW.partition_no,NEW.bootstrap,NEW.execution,NEW.predecessor);
      IF NOT FOUND OR parent.complete OR parent.verified_root IS NULL OR
        parent.verified_binding IS DISTINCT FROM NEW.verified_binding OR
        parent.verified_next IS DISTINCT FROM NEW.step OR
        NEW.verified_ordinal<>parent.verified_ordinal+1 THEN
        RAISE EXCEPTION 'Repair verification requires its contiguous original predecessor'
          USING ERRCODE='23514';
      END IF;
    END IF;
  END IF;
  IF NEW.verified_next IS NOT NULL AND OLD.verified_next IS NULL AND NOT EXISTS (
    SELECT 1 FROM semantic.public_filter_repair_step s
    WHERE (s.partition_no,s.bootstrap,s.execution,s.step,s.predecessor)=
      (NEW.partition_no,NEW.bootstrap,NEW.execution,NEW.verified_next,NEW.step)) THEN
    RAISE EXCEPTION 'Repair verification cannot branch or skip an original page' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER public_filter_repair_step_immutable ON semantic.public_filter_repair_step;
CREATE TRIGGER public_filter_repair_step_immutable
  BEFORE UPDATE OR DELETE ON semantic.public_filter_repair_step
  FOR EACH ROW EXECUTE FUNCTION semantic.retain_public_filter_repair_verification();

-- migrate:down
DO $$ BEGIN RAISE EXCEPTION 'Original public-filter verification requires native retirement'; END $$;
