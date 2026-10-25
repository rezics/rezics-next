-- migrate:up
-- Board candidates retain only the ranking inputs and the current materialized rank.
DROP TRIGGER board_thread_identity ON content.board_thread;

ALTER TABLE content.board_thread
  ADD COLUMN last_activity_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  ADD COLUMN score integer NOT NULL DEFAULT 0,
  ADD COLUMN active_rank double precision NOT NULL DEFAULT 0,
  ADD COLUMN rank_refreshed_at timestamptz NOT NULL DEFAULT transaction_timestamp();

CREATE FUNCTION content.board_thread_active_rank(p_score integer, p_activity_at timestamptz, p_at timestamptz)
RETURNS double precision
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT CASE
    WHEN p_activity_at < p_at - INTERVAL '7 days' THEN 0::double precision
    ELSE log(greatest(2::numeric, p_score::numeric + 2)::double precision)
      / power(greatest(0::double precision, extract(epoch FROM (p_at - p_activity_at)) / 3600.0) + 2.0, 1.8)
  END
$$;

UPDATE content.board_thread
SET last_activity_at = created_at,
    active_rank = content.board_thread_active_rank(score, created_at, transaction_timestamp()),
    rank_refreshed_at = transaction_timestamp();

ALTER TABLE content.board_thread
  ADD CONSTRAINT board_thread_last_activity_finite CHECK (isfinite(last_activity_at)),
  ADD CONSTRAINT board_thread_active_rank_finite CHECK (active_rank >= 0 AND active_rank < 'Infinity'::double precision),
  ADD CONSTRAINT board_thread_rank_refreshed_finite CHECK (isfinite(rank_refreshed_at));

CREATE INDEX board_thread_active_page_idx
  ON content.board_thread (route, board_id, active_rank DESC, thread_id);

CREATE INDEX board_thread_rank_refresh_idx
  ON content.board_thread (rank_refreshed_at, route, board_id, thread_id)
  WHERE active_rank <> 0;

CREATE OR REPLACE FUNCTION content.guard_board_thread() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.route, NEW.board_id, NEW.thread_id, NEW.created_at)
     IS DISTINCT FROM ROW(OLD.route, OLD.board_id, OLD.thread_id, OLD.created_at)
     OR ROW(NEW.source_epoch, NEW.source_position) < ROW(OLD.source_epoch, OLD.source_position)
     OR (ROW(NEW.source_epoch, NEW.source_position) = ROW(OLD.source_epoch, OLD.source_position)
         AND NEW.source_revision_id IS DISTINCT FROM OLD.source_revision_id)
     OR NEW.last_activity_at < OLD.last_activity_at THEN
    RAISE EXCEPTION 'Board candidate identity, activity and source watermark cannot regress' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER board_thread_identity BEFORE UPDATE ON content.board_thread
FOR EACH ROW EXECUTE FUNCTION content.guard_board_thread();

CREATE FUNCTION content.refresh_board_thread_rank_batch(
  p_at timestamptz DEFAULT clock_timestamp(),
  p_limit integer DEFAULT 500
)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  refreshed integer;
BEGIN
  IF NOT isfinite(p_at) OR p_limit < 1 OR p_limit > 500 THEN
    RAISE EXCEPTION 'Invalid board rank refresh batch';
  END IF;

  PERFORM set_config('enable_seqscan', 'off', true);

  WITH selected AS MATERIALIZED (
    SELECT route, board_id, thread_id
    FROM content.board_thread
    WHERE active_rank <> 0
      AND rank_refreshed_at <= p_at - INTERVAL '10 minutes'
    ORDER BY rank_refreshed_at, route, board_id, thread_id
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  ), updated AS (
    UPDATE content.board_thread AS candidate
    SET active_rank = content.board_thread_active_rank(candidate.score, candidate.last_activity_at, p_at),
        rank_refreshed_at = p_at
    FROM selected
    WHERE candidate.route = selected.route
      AND candidate.board_id = selected.board_id
      AND candidate.thread_id = selected.thread_id
    RETURNING 1
  )
  SELECT count(*)::integer INTO refreshed FROM updated;

  RETURN refreshed;
END;
$$;

-- migrate:down
-- Forward only: board rank state is maintained as part of the projection watermark.
