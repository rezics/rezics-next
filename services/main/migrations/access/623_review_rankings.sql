-- A serialized Access source records active review count changes. Replaying it
-- rebuilds review rankings after a Content or Graph lineage change.
ALTER TABLE access.read_ranking_checkpoint ADD COLUMN review_position bigint NOT NULL DEFAULT 0
  CHECK (review_position >= 0);
ALTER TABLE access.read_ranking_score DROP CONSTRAINT read_ranking_score_metric_check;
ALTER TABLE access.read_ranking_score ADD CONSTRAINT read_ranking_score_metric_check
  CHECK (metric IN ('reads', 'finished-chapters', 'reviews'));

CREATE TABLE access.reader_review_rank_head (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  position bigint NOT NULL DEFAULT 0 CHECK (position >= 0)
);
INSERT INTO access.reader_review_rank_head (singleton) VALUES (true);
CREATE TABLE access.reader_review_rank_change (
  position bigint PRIMARY KEY CHECK (position > 0),
  work text NOT NULL,
  occurred_at timestamptz NOT NULL,
  delta smallint NOT NULL CHECK (delta IN (-1, 1))
);
CREATE FUNCTION access.append_reader_review_rank_change(_work text,
  _at timestamptz, _delta integer) RETURNS void LANGUAGE plpgsql AS $$
DECLARE _position bigint;
BEGIN
  UPDATE access.reader_review_rank_head SET position = position + 1
    WHERE singleton RETURNING position INTO _position;
  INSERT INTO access.reader_review_rank_change (position, work, occurred_at, delta)
    VALUES (_position, _work, _at, _delta);
END $$;

-- Backfill reviews already present when this migration is applied.
INSERT INTO access.reader_review_rank_change (position, work, occurred_at, delta)
  SELECT row_number() OVER (ORDER BY created_at, id), work, created_at, 1
  FROM access.reader_review WHERE NOT deleted;
UPDATE access.reader_review_rank_head SET position =
  (SELECT count(*) FROM access.reader_review_rank_change);

CREATE FUNCTION access.reader_review_rank_visible(_id uuid, _revision uuid,
  _context text, _realm text) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT NOT EXISTS (SELECT 1 FROM access.governance_enforcement e
    WHERE e.owner = 'review' AND e.resource = _id::text AND e.component = 'body'
      AND e.state = 'restricted' AND e.effect IN ('disclosure', 'publication')
      AND (e.revision IS NULL OR e.revision = _revision::text)
      AND e.context IN ('urn:rezics:context:global', _context, _realm))
$$;
CREATE FUNCTION access.track_reader_review_rank() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE _old_visible boolean := false; _new_visible boolean := false;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    _old_visible := NOT OLD.deleted AND access.reader_review_rank_visible(
      OLD.id, OLD.revision, OLD.context, OLD.realm);
  END IF;
  IF TG_OP <> 'DELETE' THEN
    _new_visible := NOT NEW.deleted AND access.reader_review_rank_visible(
      NEW.id, NEW.revision, NEW.context, NEW.realm);
  END IF;
  IF _old_visible AND NOT _new_visible THEN
    PERFORM access.append_reader_review_rank_change(OLD.work, OLD.created_at, -1);
  ELSIF NOT _old_visible AND _new_visible THEN
    PERFORM access.append_reader_review_rank_change(NEW.work, NEW.created_at, 1);
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER track_reader_review_rank AFTER INSERT OR UPDATE OF deleted, revision,
  created_at, context, realm ON access.reader_review
  FOR EACH ROW EXECUTE FUNCTION access.track_reader_review_rank();
CREATE TRIGGER track_reader_review_rank_deleted AFTER DELETE ON access.reader_review
  FOR EACH ROW EXECUTE FUNCTION access.track_reader_review_rank();
