-- migrate:up
ALTER TABLE rating.vote
  ADD COLUMN counted_target uuid,
  ADD COLUMN counted_revision integer NOT NULL DEFAULT 1;

UPDATE rating.vote
SET counted_target = target_id,
    counted_revision = revision;

ALTER TABLE rating.vote
  ADD CONSTRAINT vote_counted_revision_check CHECK (counted_revision >= 1);

CREATE FUNCTION rating.initialize_vote_counting() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.counted_target IS NULL THEN NEW.counted_target := NEW.target_id; END IF;
  NEW.counted_revision := GREATEST(NEW.counted_revision, NEW.revision);
  RETURN NEW;
END;
$$;

CREATE TRIGGER vote_initialize_counting
BEFORE INSERT ON rating.vote
FOR EACH ROW EXECUTE FUNCTION rating.initialize_vote_counting();

CREATE UNIQUE INDEX vote_counted_target_idx
  ON rating.vote (route, voter_id, question_id, counted_target)
  WHERE counted_target IS NOT NULL;

CREATE INDEX population_vote_target_voter_page_idx
  ON rating.population_vote (route, population_id, target_id, voter_id, question_id);

-- migrate:down
-- Forward only: subject merges change the meaning of the stored population votes.
