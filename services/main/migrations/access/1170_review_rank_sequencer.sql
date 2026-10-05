-- Existing positions and checkpoints survive unchanged. New writers append
-- xid-stamped rows; only the ranking worker assigns contiguous positions.
ALTER TABLE access.reader_review_rank_change DROP CONSTRAINT reader_review_rank_change_pkey,
  ALTER COLUMN position DROP NOT NULL,
  ADD COLUMN id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ADD COLUMN epoch bigint NOT NULL DEFAULT 0,
  ADD COLUMN xid xid8 NOT NULL DEFAULT '0'::xid8;
UPDATE access.reader_review_rank_change SET epoch = (SELECT generation FROM access.recovery_fence WHERE id);
ALTER TABLE access.reader_review_rank_change ALTER COLUMN xid SET DEFAULT pg_current_xact_id();
CREATE UNIQUE INDEX reader_review_rank_position ON access.reader_review_rank_change(position) WHERE position IS NOT NULL;
CREATE INDEX reader_review_rank_pending ON access.reader_review_rank_change(epoch,xid,id) WHERE position IS NULL;

CREATE OR REPLACE FUNCTION access.append_reader_review_rank_change(_work text, _at timestamptz, _delta integer)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO access.reader_review_rank_change(epoch,work,occurred_at,delta)
  SELECT generation,_work,_at,_delta FROM access.recovery_fence WHERE id FOR SHARE;
$$;

CREATE FUNCTION access.sequence_reader_review_ranks(batch integer) RETURNS integer
LANGUAGE plpgsql SET lock_timeout = '2s' AS $$
DECLARE head bigint; assigned integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM access.reader_review_rank_change WHERE position IS NULL) THEN RETURN 0; END IF;
  SELECT position INTO head FROM access.reader_review_rank_head WHERE singleton FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN NULL; END IF;
  -- One snapshot for the range and horizon. xmin excludes every transaction
  -- that could still append an earlier key, including a late identity allocation.
  -- https://www.postgresql.org/docs/current/functions-info.html#FUNCTIONS-PG-SNAPSHOT
  WITH pending AS (
    SELECT id,row_number() OVER (ORDER BY epoch,xid,id) AS n FROM (
      SELECT id,epoch,xid FROM access.reader_review_rank_change
      WHERE position IS NULL AND (epoch,xid) <
        ((SELECT generation FROM access.recovery_fence WHERE id),pg_snapshot_xmin(pg_current_snapshot()))
      ORDER BY epoch,xid,id LIMIT batch) rows
  ), numbered AS (
    UPDATE access.reader_review_rank_change c SET position = head + p.n FROM pending p WHERE c.id = p.id RETURNING c.id
  ) SELECT count(*) INTO assigned FROM numbered;
  IF assigned > 0 THEN UPDATE access.reader_review_rank_head SET position = head + assigned WHERE singleton; END IF;
  RETURN assigned;
END $$;
