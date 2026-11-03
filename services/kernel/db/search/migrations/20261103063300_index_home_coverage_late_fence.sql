-- migrate:up
-- A missing fence is late publication, not an absent home. A fence still requires current.
ALTER TABLE search.index_home_coverage DROP CONSTRAINT index_home_coverage_check;
ALTER TABLE search.index_home_coverage
  ADD CONSTRAINT index_home_coverage_check CHECK (fence IS NULL OR current IS NOT NULL);

-- migrate:down
ALTER TABLE search.index_home_coverage DROP CONSTRAINT index_home_coverage_check;
ALTER TABLE search.index_home_coverage
  ADD CONSTRAINT index_home_coverage_check CHECK ((current IS NULL) = (fence IS NULL));
