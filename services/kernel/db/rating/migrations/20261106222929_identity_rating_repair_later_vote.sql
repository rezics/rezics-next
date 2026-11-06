-- migrate:up
-- Content-owned Rating vote writer marks Semantic later_vote for keys beyond the
-- captured through_* upper bound. Fanout is the same 64-row page as mapping drain.
CREATE FUNCTION rating.touch_identity_rating_repair_later_vote() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM semantic.mark_identity_rating_repair_later_vote(NEW.route / 16, NEW.voter_id, NEW.question_id, NEW.target_id);
  RETURN NEW;
END;
$$;

CREATE TRIGGER identity_rating_repair_later_vote
AFTER INSERT OR UPDATE OF question_id, target_id ON rating.vote
FOR EACH ROW EXECUTE FUNCTION rating.touch_identity_rating_repair_later_vote();

-- migrate:down
DROP TRIGGER IF EXISTS identity_rating_repair_later_vote ON rating.vote;
DROP FUNCTION IF EXISTS rating.touch_identity_rating_repair_later_vote();
