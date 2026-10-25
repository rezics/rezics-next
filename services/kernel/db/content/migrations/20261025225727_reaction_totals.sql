-- migrate:up
-- Contribution rows retain each source partition's idempotency watermark. This
-- compact projection gives target reads one row per reaction kind.
CREATE TABLE content.reaction_total (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  target_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('upvote', 'downvote', 'like', 'love', 'laugh', 'insightful', 'sad')),
  count integer NOT NULL CHECK (count >= 0),
  source_epoch integer NOT NULL CHECK (source_epoch > 0),
  source_position bigint NOT NULL CHECK (source_position > 0),
  PRIMARY KEY (route, target_id, kind),
  CHECK (route = get_byte(uuid_send(target_id), 10) * 256 + get_byte(uuid_send(target_id), 11))
);

WITH sums AS (
  SELECT route, target_id, kind, sum(count)::integer AS count
  FROM content.reaction_count
  GROUP BY route, target_id, kind
), newest AS (
  SELECT DISTINCT ON (route, target_id, kind)
         route, target_id, kind, source_epoch, source_position
  FROM content.reaction_count
  ORDER BY route, target_id, kind, source_epoch DESC, source_position DESC
)
INSERT INTO content.reaction_total (route, target_id, kind, count, source_epoch, source_position)
SELECT sums.route, sums.target_id, sums.kind, sums.count, newest.source_epoch, newest.source_position
FROM sums
JOIN newest USING (route, target_id, kind);

CREATE FUNCTION content.guard_reaction_total() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.route, NEW.target_id, NEW.kind)
       IS DISTINCT FROM ROW(OLD.route, OLD.target_id, OLD.kind)
     OR ROW(NEW.source_epoch, NEW.source_position) < ROW(OLD.source_epoch, OLD.source_position) THEN
    RAISE EXCEPTION 'Reaction total identity and source watermark cannot regress' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER reaction_total_identity BEFORE UPDATE ON content.reaction_total
FOR EACH ROW EXECUTE FUNCTION content.guard_reaction_total();

-- migrate:down
DROP TRIGGER reaction_total_identity ON content.reaction_total;
DROP FUNCTION content.guard_reaction_total();
DROP TABLE content.reaction_total;
