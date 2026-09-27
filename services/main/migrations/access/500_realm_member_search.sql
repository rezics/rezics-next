-- Agent provision names are immutable, and an active provision is the public
-- Agent profile's name source. Never index the associated Account identity.
-- PostgreSQL 18 normalize/casefold preserve contiguous CJK text and fold width:
-- https://www.postgresql.org/docs/18/functions-string.html (2026-09-28).
CREATE FUNCTION access.realm_member_search_key(value text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT normalize(casefold(normalize(value, NFKC) COLLATE pg_catalog.pg_unicode_fast), NFKC)
$$;

-- GIN candidates for one-character and longer substring queries. Exact matching
-- follows the index probe: a set of bigrams alone does not prove their ordering.
-- Storage is O(name length), including single-character CJK names/queries.
CREATE FUNCTION access.realm_member_search_terms(value text) RETURNS text[]
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT COALESCE(array_agg(DISTINCT substring(value FROM token_start FOR token_width)), ARRAY[]::text[])
  FROM generate_series(1, char_length(value)) AS token_start
  CROSS JOIN generate_series(1, 2) AS token_width
  WHERE token_start + token_width - 1 <= char_length(value)
$$;

-- Eager index maintenance avoids scanning a bulk insert's pending-entry list
-- on interactive reads. Names/handles are bounded and change infrequently.
-- https://www.postgresql.org/docs/18/gin.html#GIN-FAST-UPDATE
CREATE INDEX realm_member_name_search ON access.agent_provision USING gin
  (access.realm_member_search_terms(access.realm_member_search_key(display_name)))
  WITH (fastupdate = off)
  WHERE state = 'active';
CREATE INDEX realm_member_handle_search ON access.agent_handle USING gin
  (access.realm_member_search_terms(access.realm_member_search_key(handle)))
  WITH (fastupdate = off)
  WHERE state = 'current';
