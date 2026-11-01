-- migrate:up
-- Proof and funded ACK progress extend the original immutable repair authority.
ALTER TABLE semantic.public_filter_repair_step
  ADD COLUMN verified_home integer CHECK (verified_home BETWEEN 0 AND 4095),
  ADD COLUMN ack_after integer NOT NULL DEFAULT 0 CHECK (ack_after BETWEEN 0 AND 4096),
  ADD CONSTRAINT public_filter_repair_home_proof CHECK
    (verified_home IS NULL OR (verified_root IS NOT NULL AND NOT complete)),
  ADD CONSTRAINT public_filter_repair_ack_proof CHECK
    (ack_after=0 OR (complete AND verified_root IS NOT NULL AND verified_next IS NULL));
CREATE UNIQUE INDEX public_filter_repair_verified_home
  ON semantic.public_filter_repair_step (partition_no,bootstrap,execution,verified_home)
  WHERE verified_home IS NOT NULL;

CREATE FUNCTION semantic.retain_public_filter_repair_ack() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.verified_home IS NOT NULL AND NEW.verified_home IS DISTINCT FROM OLD.verified_home)
    OR NEW.ack_after<OLD.ack_after OR NEW.ack_after>OLD.ack_after+1
    OR (NEW.ack_after<>OLD.ack_after AND
      (NOT OLD.complete OR OLD.verified_root IS NULL OR OLD.verified_next IS NOT NULL)) THEN
    RAISE EXCEPTION 'Original repair window and contiguous ACK progress cannot be replaced'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER public_filter_repair_ack_immutable
  BEFORE UPDATE ON semantic.public_filter_repair_step
  FOR EACH ROW EXECUTE FUNCTION semantic.retain_public_filter_repair_ack();

-- migrate:down
DO $$ BEGIN
  RAISE EXCEPTION 'Retained native repair ACK requires original Source retirement';
END $$;
