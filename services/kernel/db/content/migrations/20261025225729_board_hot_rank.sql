-- migrate:up
ALTER TABLE content.board_thread
  ADD COLUMN hot_rank double precision NOT NULL DEFAULT 0;

UPDATE content.board_thread
SET hot_rank = content.board_thread_active_rank(score, created_at, transaction_timestamp());

ALTER TABLE content.board_thread
  ADD CONSTRAINT board_thread_hot_rank_finite
    CHECK (hot_rank >= 0 AND hot_rank < 'Infinity'::double precision);

CREATE INDEX board_thread_hot_page_idx
  ON content.board_thread (route, board_id, hot_rank DESC, thread_id);

DROP FUNCTION content.refresh_board_thread_rank_batch(timestamptz, integer);

-- migrate:down
-- Forward only: score and rank refreshes use the owning content adapter.
