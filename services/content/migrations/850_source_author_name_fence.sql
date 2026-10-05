-- Search, including an empty result, fences all name heads. Normal writes append
-- independently; only recovery advances the epoch and drains their shared locks.
CREATE TABLE source.author_name_epoch (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  version bigint NOT NULL CHECK (version >= 0)
);
INSERT INTO source.author_name_epoch(singleton,version)
  SELECT id,generation FROM source.author_name_generation;
DROP TABLE source.author_name_generation;

CREATE TABLE source.author_name_change (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  epoch bigint NOT NULL,
  xid xid8 NOT NULL DEFAULT pg_current_xact_id()
);
CREATE INDEX author_name_change_order ON source.author_name_change(epoch,xid,id);

CREATE FUNCTION source.record_author_name_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('rezics.author_name_changed',true) = 'on' THEN RETURN NULL; END IF;
  INSERT INTO source.author_name_change(epoch)
    SELECT version FROM source.author_name_epoch WHERE singleton FOR SHARE;
  PERFORM set_config('rezics.author_name_changed','on',true);
  RETURN NULL;
END $$;
CREATE TRIGGER author_name_head_change AFTER INSERT OR UPDATE OR DELETE ON source.author_name_head
  FOR EACH STATEMENT EXECUTE FUNCTION source.record_author_name_change();

CREATE FUNCTION source.advance_author_name_restore_epoch() RETURNS bigint LANGUAGE sql AS $$
  UPDATE source.author_name_epoch SET version = version + 1 WHERE singleton RETURNING version;
$$;

-- One indexed head seek plus the visible unsettled range. A count detects late
-- lower-xid commits even while another transaction pins xmin; unrelated snapshot
-- activity cannot move it. Recovery settles copied high xids in an older epoch.
CREATE FUNCTION source.author_name_search_generation() RETURNS text LANGUAGE sql STABLE AS $$
  WITH horizon AS MATERIALIZED (
    SELECT o.data_epoch,g.version AS epoch,pg_snapshot_xmin(pg_current_snapshot()) AS xmin
      FROM content.owner_control o CROSS JOIN source.author_name_epoch g WHERE o.singleton AND g.singleton
  )
  SELECT encode(sha256(convert_to(concat_ws('|',h.data_epoch::text,h.epoch::text,
    (SELECT concat_ws('/',c.epoch::text,c.xid::text,c.id::text) FROM source.author_name_change c
      WHERE (c.epoch,c.xid) < (h.epoch,h.xmin)
      ORDER BY c.epoch DESC,c.xid DESC,c.id DESC LIMIT 1),
    (SELECT count(*) FROM source.author_name_change c
      WHERE (c.epoch,c.xid) >= (h.epoch,h.xmin))),'UTF8')),'hex')
  FROM horizon h;
$$;

-- Two seeks and at most 256 deletes. Preserve the largest settled key and all
-- unsettled rows so pruning does not change the equality fence.
CREATE FUNCTION source.prune_author_name_changes() RETURNS integer LANGUAGE sql
SET lock_timeout = '2s' SET statement_timeout = '5s' AS $$
  WITH horizon AS MATERIALIZED (
    SELECT version AS epoch,pg_snapshot_xmin(pg_current_snapshot()) AS xmin
      FROM source.author_name_epoch WHERE singleton
  ), keeper AS MATERIALIZED (
    SELECT c.epoch,c.xid,c.id FROM source.author_name_change c
      WHERE (c.epoch,c.xid) < (SELECT epoch,xmin FROM horizon)
      ORDER BY c.epoch DESC,c.xid DESC,c.id DESC LIMIT 1
  ), removed AS (
    DELETE FROM source.author_name_change WHERE ctid = ANY(ARRAY(
      SELECT c.ctid FROM source.author_name_change c
      WHERE (c.epoch,c.xid,c.id) < (SELECT epoch,xid,id FROM keeper)
      ORDER BY c.epoch,c.xid,c.id LIMIT 256 FOR UPDATE OF c SKIP LOCKED
    )) RETURNING id
  )
  SELECT count(*)::integer FROM removed;
$$;
