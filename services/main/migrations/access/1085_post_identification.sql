-- A receipt journal for composed owner commands; no text, custody or placement
-- moves. Each checkpoint contains only the corresponding durable API receipt.
CREATE TABLE access.post_identification (
  id uuid PRIMARY KEY,
  principal_id uuid NOT NULL REFERENCES access.principal(id),
  acting_subject text NOT NULL,
  post text NOT NULL,
  idempotency_key text NOT NULL,
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  intent jsonb NOT NULL,
  authority_resource text NOT NULL,
  definition_ref text NOT NULL,
  definition_id text NOT NULL,
  steps jsonb NOT NULL DEFAULT '{}'::jsonb,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (principal_id, acting_subject, post, idempotency_key)
);
CREATE INDEX post_identification_page ON access.post_identification(post, id)
  WHERE result IS NOT NULL;
CREATE TABLE access.post_identification_inventory (
  post text PRIMARY KEY,
  generation bigint NOT NULL DEFAULT 0
);
-- Several pieces of evidence can identify the same realization. The reader
-- traverses Works, while the journal keeps every receipt independently.
CREATE TABLE access.post_identification_work (
  post text NOT NULL,
  work text NOT NULL,
  identification uuid NOT NULL REFERENCES access.post_identification(id),
  PRIMARY KEY (post, work)
);
