-- migrate:up
-- The exact registration and its sparse behind index own the nine-home probe.
CREATE FUNCTION semantic.public_filter_book_dirty_homes(registration_id text)
RETURNS SETOF search.public_filter_coverage_home
LANGUAGE sql STABLE SET enable_seqscan = off AS $$
  SELECT h.* FROM search.public_filter_coverage_home h
  WHERE h.partition_no = 0 AND h.registration = registration_id AND h.behind
  ORDER BY h.source_home LIMIT 9
$$;

-- This predicate has its own partial index. The quiet population does not scan every home.
CREATE FUNCTION semantic.public_filter_population_is_fenced()
RETURNS boolean
LANGUAGE sql STABLE SET enable_seqscan = off AS $$
  SELECT EXISTS (SELECT 1 FROM semantic.public_filter_privacy_head WHERE population_fenced)
$$;

-- migrate:down
DROP FUNCTION semantic.public_filter_population_is_fenced();
DROP FUNCTION semantic.public_filter_book_dirty_homes(text);
