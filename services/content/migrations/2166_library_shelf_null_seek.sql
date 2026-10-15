-- Each nullable shelf ordering has two disjoint seeks. Separate indexes make
-- each range match the page predicate, including the missing-value tail.
DROP INDEX reader.library_status_finished_shelf;
CREATE INDEX library_status_finished_shelf ON reader.library_status(agent,status,finished_on,work)
  WHERE status IS NOT NULL AND finished_on IS NOT NULL;
CREATE INDEX library_status_finished_missing ON reader.library_status(agent,status,work)
  WHERE status IS NOT NULL AND finished_on IS NULL;
DROP INDEX reader.library_status_title_shelf;
CREATE INDEX library_status_title_shelf ON reader.library_status(agent,status,title_key COLLATE "C",work)
  WHERE status IS NOT NULL AND title_key IS NOT NULL;
CREATE INDEX library_status_title_missing ON reader.library_status(agent,status,work)
  WHERE status IS NOT NULL AND title_key IS NULL;
DROP INDEX reader.library_status_rating_shelf;
CREATE INDEX library_status_rating_shelf ON reader.library_status(agent,status,own_rating,work)
  WHERE status IS NOT NULL AND own_rating IS NOT NULL;
CREATE INDEX library_status_rating_missing ON reader.library_status(agent,status,work)
  WHERE status IS NOT NULL AND own_rating IS NULL;
DROP INDEX reader.library_status_last_read_shelf;
CREATE INDEX library_status_last_read_shelf ON reader.library_status(agent,status,last_read_at,work)
  WHERE status IS NOT NULL AND last_read_at IS NOT NULL;
CREATE INDEX library_status_last_read_missing ON reader.library_status(agent,status,work)
  WHERE status IS NOT NULL AND last_read_at IS NULL;
