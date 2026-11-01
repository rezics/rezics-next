-- migrate:up
-- A verified original window continues to depend on its original outbox pin.
-- Checkpoint delivery must not advance or remove that pin independently of the
-- Source's enrollment, users and captured obligations. Other consumers keep
-- their ordinary checkpoint behavior.
CREATE FUNCTION semantic.retain_public_filter_creation_checkpoint() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE original semantic.public_filter_home_enrollment;
BEGIN
  IF OLD.consumer !~ '^public_filter_[0-9a-f]{32}$' THEN
    IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  SELECT * INTO original FROM semantic.public_filter_home_enrollment
    WHERE (partition_no,bootstrap)=
      (OLD.partition_no,substring(OLD.consumer FROM 15)::uuid)
      AND creation_consumer=OLD.consumer;
  IF NOT FOUND THEN
    IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  IF TG_OP='DELETE' OR
    (NEW.partition_no,NEW.consumer,NEW.epoch,NEW.position)
      IS DISTINCT FROM (OLD.partition_no,OLD.consumer,OLD.epoch,OLD.position) THEN
    RAISE EXCEPTION 'Original public-filter creation pin is still retained'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER public_filter_creation_checkpoint_retained
  BEFORE UPDATE OR DELETE ON core.consumer_checkpoint
  FOR EACH ROW EXECUTE FUNCTION semantic.retain_public_filter_creation_checkpoint();

-- migrate:down
DO $$ BEGIN RAISE EXCEPTION 'Original public-filter pins require native retirement'; END $$;
