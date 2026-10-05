-- Equality fences retain the largest settled key and count only visible changes
-- at/above xmin. Unrelated snapshots cannot move that count; a late lower-xid
-- commit still adds a row while an older writer pins the horizon.
-- https://www.postgresql.org/docs/18/functions-info.html#FUNCTIONS-PG-SNAPSHOT
-- Reads cost one head seek plus the unsettled range, never the settled history.
-- Pruning costs two seeks and at most 256 deletes per signal and keeps the head.
-- Scalar cut keys let ordered seeks stop at LIMIT; locked ctid arrays bound
-- deletion lookups. Cross joins and id semi-joins can scan the history instead.

CREATE OR REPLACE FUNCTION access.site_moderation_basis() RETURNS text LANGUAGE sql STABLE AS $$
  WITH horizon AS MATERIALIZED (
    SELECT generation,pg_snapshot_xmin(pg_current_snapshot()) AS xmin FROM access.recovery_fence WHERE id
  )
  SELECT encode(sha256(convert_to(concat_ws('|',p.revision::text,h.generation::text,
    (SELECT concat_ws('/',c.epoch::text,c.xid::text,c.id::text) FROM access.site_moderation_change c
      WHERE (c.epoch,c.xid) < (h.generation,h.xmin)
      ORDER BY c.epoch DESC,c.xid DESC,c.id DESC LIMIT 1),
    (SELECT count(*) FROM access.site_moderation_change c
      WHERE (c.epoch,c.xid) >= (h.generation,h.xmin))),'UTF8')),'hex')
  FROM access.site_moderation_position p CROSS JOIN horizon h WHERE p.id;
$$;

CREATE FUNCTION access.prune_site_moderation_changes() RETURNS integer LANGUAGE sql
SET lock_timeout = '2s' SET statement_timeout = '5s' AS $$
  WITH horizon AS MATERIALIZED (
    SELECT generation,pg_snapshot_xmin(pg_current_snapshot()) AS xmin FROM access.recovery_fence WHERE id AND open
  ), keeper AS MATERIALIZED (
    SELECT c.epoch,c.xid,c.id FROM access.site_moderation_change c
      WHERE (c.epoch,c.xid) < (SELECT generation,xmin FROM horizon)
      ORDER BY c.epoch DESC,c.xid DESC,c.id DESC LIMIT 1
  ), removed AS (
    DELETE FROM access.site_moderation_change WHERE ctid = ANY(ARRAY(
      SELECT c.ctid FROM access.site_moderation_change c
      WHERE (c.epoch,c.xid,c.id) < (SELECT epoch,xid,id FROM keeper)
      ORDER BY c.epoch,c.xid,c.id LIMIT 256 FOR UPDATE OF c SKIP LOCKED
    )) RETURNING id
  )
  SELECT count(*)::integer FROM removed;
$$;

CREATE OR REPLACE FUNCTION access.realm_count_basis() RETURNS text LANGUAGE sql STABLE AS $$
  WITH horizon AS MATERIALIZED (
    SELECT generation,pg_snapshot_xmin(pg_current_snapshot()) AS xmin FROM access.recovery_fence WHERE id
  )
  SELECT encode(sha256(convert_to(concat_ws('|',p.revision::text,h.generation::text,
    (SELECT concat_ws('/',c.epoch::text,c.xid::text,c.id::text) FROM access.realm_count_change c
      WHERE (c.epoch,c.xid) < (h.generation,h.xmin)
      ORDER BY c.epoch DESC,c.xid DESC,c.id DESC LIMIT 1),
    (SELECT count(*) FROM access.realm_count_change c
      WHERE (c.epoch,c.xid) >= (h.generation,h.xmin))),'UTF8')),'hex')
  FROM access.realm_count_position p CROSS JOIN horizon h WHERE p.singleton;
$$;

CREATE FUNCTION access.prune_realm_count_changes() RETURNS integer LANGUAGE sql
SET lock_timeout = '2s' SET statement_timeout = '5s' AS $$
  WITH horizon AS MATERIALIZED (
    SELECT generation,pg_snapshot_xmin(pg_current_snapshot()) AS xmin FROM access.recovery_fence WHERE id AND open
  ), keeper AS MATERIALIZED (
    SELECT c.epoch,c.xid,c.id FROM access.realm_count_change c
      WHERE (c.epoch,c.xid) < (SELECT generation,xmin FROM horizon)
      ORDER BY c.epoch DESC,c.xid DESC,c.id DESC LIMIT 1
  ), removed AS (
    DELETE FROM access.realm_count_change WHERE ctid = ANY(ARRAY(
      SELECT c.ctid FROM access.realm_count_change c
      WHERE (c.epoch,c.xid,c.id) < (SELECT epoch,xid,id FROM keeper)
      ORDER BY c.epoch,c.xid,c.id LIMIT 256 FOR UPDATE OF c SKIP LOCKED
    )) RETURNING id
  )
  SELECT count(*)::integer FROM removed;
$$;

CREATE OR REPLACE FUNCTION access.realm_growth_basis() RETURNS text LANGUAGE sql STABLE AS $$
  WITH horizon AS MATERIALIZED (
    SELECT generation,pg_snapshot_xmin(pg_current_snapshot()) AS xmin FROM access.recovery_fence WHERE id
  )
  SELECT encode(sha256(convert_to(concat_ws('|',p.revision::text,h.generation::text,
    (SELECT concat_ws('/',c.epoch::text,c.xid::text,c.id::text) FROM access.realm_growth_change c
      WHERE (c.epoch,c.xid) < (h.generation,h.xmin)
      ORDER BY c.epoch DESC,c.xid DESC,c.id DESC LIMIT 1),
    (SELECT count(*) FROM access.realm_growth_change c
      WHERE (c.epoch,c.xid) >= (h.generation,h.xmin))),'UTF8')),'hex')
  FROM access.realm_growth_position p CROSS JOIN horizon h WHERE p.singleton;
$$;

CREATE FUNCTION access.prune_realm_growth_changes() RETURNS integer LANGUAGE sql
SET lock_timeout = '2s' SET statement_timeout = '5s' AS $$
  WITH horizon AS MATERIALIZED (
    SELECT generation,pg_snapshot_xmin(pg_current_snapshot()) AS xmin FROM access.recovery_fence WHERE id AND open
  ), keeper AS MATERIALIZED (
    SELECT c.epoch,c.xid,c.id FROM access.realm_growth_change c
      WHERE (c.epoch,c.xid) < (SELECT generation,xmin FROM horizon)
      ORDER BY c.epoch DESC,c.xid DESC,c.id DESC LIMIT 1
  ), removed AS (
    DELETE FROM access.realm_growth_change WHERE ctid = ANY(ARRAY(
      SELECT c.ctid FROM access.realm_growth_change c
      WHERE (c.epoch,c.xid,c.id) < (SELECT epoch,xid,id FROM keeper)
      ORDER BY c.epoch,c.xid,c.id LIMIT 256 FOR UPDATE OF c SKIP LOCKED
    )) RETURNING id
  )
  SELECT count(*)::integer FROM removed;
$$;
