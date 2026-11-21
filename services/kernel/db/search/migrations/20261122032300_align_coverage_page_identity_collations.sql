-- migrate:up
-- Page custody uses the exact same opaque observation and registration keys as its parents.
-- PostgreSQL can seek the partial active-page index only with the comparison's collation.
ALTER TABLE search.public_filter_coverage_page
  ALTER COLUMN observation TYPE text COLLATE "C",
  ALTER COLUMN registration TYPE text COLLATE "C";

-- migrate:down
ALTER TABLE search.public_filter_coverage_page
  ALTER COLUMN observation TYPE text COLLATE "default",
  ALTER COLUMN registration TYPE text COLLATE "default";
