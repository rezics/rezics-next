-- migrate:up
CREATE INDEX trending_term_live_rank
ON search.trending_term(route, language, rank DESC, expires_at DESC, term_key);

-- migrate:down
DROP INDEX trending_term_live_rank;
