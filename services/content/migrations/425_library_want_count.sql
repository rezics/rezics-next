-- The public Work count probes one status and agent in index order.
CREATE INDEX library_status_want_readers_idx ON reader.library_status (work, agent)
  WHERE status = 'want-to-read';
