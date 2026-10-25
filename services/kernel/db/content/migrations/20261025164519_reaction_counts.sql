-- migrate:up
-- One row is one actor partition's contribution to a target kind. Readers sum
-- contributions into the target's counts. The source watermark rejects a stale
-- event from that same partition, so replay and reordering cannot double count.
CREATE TABLE content.reaction_count (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  target_id uuid NOT NULL,
  source_partition integer NOT NULL CHECK (source_partition BETWEEN 0 AND 4095),
  kind text NOT NULL CHECK (kind IN ('upvote', 'downvote', 'like', 'love', 'laugh', 'insightful', 'sad')),
  count integer NOT NULL CHECK (count >= 0),
  source_epoch integer NOT NULL CHECK (source_epoch > 0),
  source_position bigint NOT NULL CHECK (source_position > 0),
  PRIMARY KEY (route, target_id, source_partition, kind),
  CHECK (route = get_byte(uuid_send(target_id), 10) * 256 + get_byte(uuid_send(target_id), 11))
);

CREATE FUNCTION content.guard_reaction_count() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.route, NEW.target_id, NEW.source_partition, NEW.kind)
       IS DISTINCT FROM ROW(OLD.route, OLD.target_id, OLD.source_partition, OLD.kind)
     OR ROW(NEW.source_epoch, NEW.source_position) <= ROW(OLD.source_epoch, OLD.source_position) THEN
    RAISE EXCEPTION 'Reaction count identity and source watermark cannot regress' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER reaction_count_identity BEFORE UPDATE ON content.reaction_count
FOR EACH ROW EXECUTE FUNCTION content.guard_reaction_count();

-- migrate:down
DROP TRIGGER reaction_count_identity ON content.reaction_count;
DROP FUNCTION content.guard_reaction_count();
DROP TABLE content.reaction_count;
