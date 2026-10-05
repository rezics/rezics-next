-- The existing generation becomes the restore epoch. Legacy rows are epoch
-- zero; a restore advances it before reopening writers, so retained high xids
-- from a logical dump become settled keys without waiting for the new counter.
-- The shared epoch lock drains appenders without serializing normal writers.
ALTER TABLE reading_position.change ADD COLUMN epoch bigint NOT NULL DEFAULT 0;
DROP INDEX reading_position.reading_position_change_order;
CREATE INDEX reading_position_change_order ON reading_position.change(epoch,xid,id);

CREATE OR REPLACE FUNCTION reading_position.advance_generation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('rezics.revelation_changed',true) = 'on' THEN RETURN NULL; END IF;
  INSERT INTO reading_position.change(data_epoch,epoch)
    SELECT o.data_epoch,g.version FROM content.owner_control o
      CROSS JOIN reading_position.generation g WHERE o.singleton AND g.singleton FOR SHARE OF g;
  PERFORM set_config('rezics.revelation_changed','on',true);
  RETURN NULL;
END $$;

CREATE FUNCTION reading_position.advance_restore_epoch() RETURNS bigint LANGUAGE sql AS $$
  UPDATE reading_position.generation SET version = version + 1 WHERE singleton RETURNING version;
$$;

-- One head seek plus a count of the visible unsettled range. Counting also
-- settles a logical copy that keeps its epoch but replaces the cluster counter:
-- old high-xid rows remain constant rather than hashing each new snapshot.
CREATE OR REPLACE FUNCTION reading_position.current_generation() RETURNS text LANGUAGE sql STABLE AS $$
  WITH horizon AS MATERIALIZED (
    SELECT o.data_epoch,g.version AS epoch,pg_snapshot_xmin(pg_current_snapshot()) AS xmin
      FROM content.owner_control o CROSS JOIN reading_position.generation g WHERE o.singleton AND g.singleton
  )
  SELECT encode(sha256(convert_to(concat_ws('|',h.data_epoch::text,h.epoch::text,
    (SELECT concat_ws('/',c.epoch::text,c.xid::text,c.id::text) FROM reading_position.change c
      WHERE (c.epoch,c.xid) < (h.epoch,h.xmin)
      ORDER BY c.epoch DESC,c.xid DESC,c.id DESC LIMIT 1),
    (SELECT count(*) FROM reading_position.change c
      WHERE (c.epoch,c.xid) >= (h.epoch,h.xmin))),'UTF8')),'hex')
  FROM horizon h;
$$;

-- Two seeks and at most 256 deletes. Retain the largest settled key, including
-- a prior epoch's high xid, so maintenance never changes an equality fence.
-- Scalar cut keys stop the ordered seek at LIMIT; locked ctid arrays bound
-- deletion lookups rather than permitting a history-sized id join.
CREATE FUNCTION reading_position.prune_changes() RETURNS integer LANGUAGE sql
SET lock_timeout = '2s' SET statement_timeout = '5s' AS $$
  WITH horizon AS MATERIALIZED (
    SELECT version AS epoch,pg_snapshot_xmin(pg_current_snapshot()) AS xmin
      FROM reading_position.generation WHERE singleton
  ), keeper AS MATERIALIZED (
    SELECT c.epoch,c.xid,c.id FROM reading_position.change c
      WHERE (c.epoch,c.xid) < (SELECT epoch,xmin FROM horizon)
      ORDER BY c.epoch DESC,c.xid DESC,c.id DESC LIMIT 1
  ), removed AS (
    DELETE FROM reading_position.change WHERE ctid = ANY(ARRAY(
      SELECT c.ctid FROM reading_position.change c
      WHERE (c.epoch,c.xid,c.id) < (SELECT epoch,xid,id FROM keeper)
      ORDER BY c.epoch,c.xid,c.id LIMIT 256 FOR UPDATE OF c SKIP LOCKED
    )) RETURNING id
  )
  SELECT count(*)::integer FROM removed;
$$;
