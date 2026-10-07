-- Waiting time starts when a ranking change is appended. occurred_at stays the
-- review's own time. Add the column with no default first: a volatile default
-- on ADD COLUMN rewrites every existing row and would invent an enqueue time.
-- Those rows keep null. Later inserts take the database clock.
ALTER TABLE access.reader_review_rank_change
  ADD COLUMN enqueued_at timestamptz;
ALTER TABLE access.reader_review_rank_change
  ALTER COLUMN enqueued_at SET DEFAULT clock_timestamp();

CREATE OR REPLACE FUNCTION access.append_reader_review_rank_change(_work text, _at timestamptz, _delta integer)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO access.reader_review_rank_change(epoch,work,occurred_at,delta,enqueued_at)
  SELECT generation,_work,_at,_delta,clock_timestamp() FROM access.recovery_fence WHERE id FOR SHARE;
$$;
