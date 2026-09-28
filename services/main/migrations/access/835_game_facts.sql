-- Public game facts are supplied by a Work editor and read only after the graph
-- confirms that the Work is a public VideoGame. One bounded document per Work.
CREATE TABLE access.game_facts (
  work text PRIMARY KEY CHECK (work ~ '^https://rezics\.com/id/[0-9a-f-]{36}$'),
  revision integer NOT NULL CHECK (revision > 0),
  facts jsonb NOT NULL CHECK (jsonb_typeof(facts) = 'object'
    AND facts->>'profile' = 'game-facts-v1' AND octet_length(facts::text) <= 16384),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE access.game_facts_receipt (
  principal_id uuid NOT NULL REFERENCES access.principal(id),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  result jsonb,
  PRIMARY KEY (principal_id, idempotency_key)
);
