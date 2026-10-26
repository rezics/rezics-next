-- migrate:up
DROP INDEX content.board_thread_rank_refresh_idx;
CREATE INDEX board_thread_rank_refresh_idx
  ON content.board_thread (route, rank_refreshed_at, board_id, thread_id)
  WHERE active_rank <> 0;

-- migrate:down
DROP INDEX content.board_thread_rank_refresh_idx;
CREATE INDEX board_thread_rank_refresh_idx
  ON content.board_thread (rank_refreshed_at, route, board_id, thread_id)
  WHERE active_rank <> 0;
