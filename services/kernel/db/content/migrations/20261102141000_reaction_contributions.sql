-- migrate:up
-- Freeze source writers before taking the cutover. Rebuild derived state from
-- native slots once, so already delivered and pending old events are both safe.
LOCK TABLE content.reaction IN SHARE MODE;
LOCK TABLE content.reaction_count, content.reaction_total, content.subject_reactor IN ACCESS EXCLUSIVE MODE;

CREATE TABLE content.reaction_projection_baseline (
  source_partition integer PRIMARY KEY CHECK (source_partition BETWEEN 0 AND 4095),
  source_epoch integer NOT NULL CHECK (source_epoch > 0),
  source_position bigint NOT NULL CHECK (source_position >= 0)
);
INSERT INTO content.reaction_projection_baseline
SELECT partition_no, epoch, position FROM core.partition;

CREATE TABLE content.reaction_contribution (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  target_id uuid NOT NULL,
  actor_account_id uuid NOT NULL,
  kind text CHECK (kind IN ('upvote', 'downvote', 'like', 'love', 'laugh', 'insightful', 'sad')),
  source_epoch integer NOT NULL CHECK (source_epoch > 0),
  source_position bigint NOT NULL CHECK (source_position > 0),
  PRIMARY KEY (route, target_id, actor_account_id),
  CHECK (route = get_byte(uuid_send(target_id), 10) * 256 + get_byte(uuid_send(target_id), 11))
);
INSERT INTO content.reaction_contribution
SELECT slot.target_route, slot.target_id, slot.actor_account_id, slot.kind, cutover.source_epoch, cutover.source_position
FROM content.reaction AS slot
JOIN content.reaction_projection_baseline AS cutover ON cutover.source_partition = slot.route / 16;

-- Counts no longer decide idempotency: another actor's older event can advance
-- a contribution without advancing its partition's aggregate watermark.
CREATE OR REPLACE FUNCTION content.guard_reaction_count() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.route, NEW.target_id, NEW.source_partition, NEW.kind)
       IS DISTINCT FROM ROW(OLD.route, OLD.target_id, OLD.source_partition, OLD.kind)
     OR ROW(NEW.source_epoch, NEW.source_position) < ROW(OLD.source_epoch, OLD.source_position) THEN
    RAISE EXCEPTION 'Reaction count identity and source watermark cannot regress' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DELETE FROM content.reaction_count;
DELETE FROM content.reaction_total;
DELETE FROM content.subject_reactor;
INSERT INTO content.reaction_count (route, target_id, source_partition, kind, count, source_epoch, source_position)
SELECT slot.target_route, slot.target_id, slot.route / 16, slot.kind, count(*)::integer,
       cutover.source_epoch, cutover.source_position
FROM content.reaction AS slot
JOIN content.reaction_projection_baseline AS cutover ON cutover.source_partition = slot.route / 16
GROUP BY slot.target_route, slot.target_id, slot.route / 16, slot.kind, cutover.source_epoch, cutover.source_position;

WITH sums AS (
  SELECT route, target_id, kind, sum(count)::integer AS count FROM content.reaction_count
  GROUP BY route, target_id, kind
), newest AS (
  SELECT DISTINCT ON (route, target_id, kind) route, target_id, kind, source_epoch, source_position
  FROM content.reaction_count ORDER BY route, target_id, kind, source_epoch DESC, source_position DESC
)
INSERT INTO content.reaction_total
SELECT sums.route, sums.target_id, sums.kind, sums.count, newest.source_epoch, newest.source_position
FROM sums JOIN newest USING (route, target_id, kind);

INSERT INTO content.subject_reactor
SELECT target_route, target_id, actor_account_id, kind FROM content.reaction WHERE target_kind = 'subject';

-- migrate:down
DROP TABLE content.reaction_contribution;
DROP TABLE content.reaction_projection_baseline;
CREATE OR REPLACE FUNCTION content.guard_reaction_count() RETURNS trigger
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
