-- migrate:up
CREATE TABLE semantic.context_extension (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  context_id uuid NOT NULL,
  digest text NOT NULL CHECK (digest ~ '^sha256:[0-9a-f]{64}$'),
  body jsonb NOT NULL,
  recorded_transaction_id uuid NOT NULL,
  PRIMARY KEY (route, context_id, digest),
  CHECK (route = get_byte(uuid_send(context_id), 10) * 256 + get_byte(uuid_send(context_id), 11))
);
CREATE TABLE semantic.context_extension_activation (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  context_id uuid NOT NULL,
  head integer NOT NULL CHECK (head >= 1),
  digest text NOT NULL,
  recorded_transaction_id uuid NOT NULL,
  PRIMARY KEY (route, context_id, head),
  FOREIGN KEY (route, context_id, digest) REFERENCES semantic.context_extension (route, context_id, digest)
);
-- A release as one Context sees it is addressed by the digest of the composed body. Rows are derived from a parent
-- release and one extension, so a stored release digest resolves again in any process.
CREATE TABLE semantic.release_composite (
  digest text PRIMARY KEY CHECK (digest ~ '^sha256:[0-9a-f]{64}$'),
  parent_digest text NOT NULL CHECK (parent_digest ~ '^sha256:[0-9a-f]{64}$'),
  extension_route integer NOT NULL,
  extension_context_id uuid NOT NULL,
  extension_digest text NOT NULL,
  FOREIGN KEY (extension_route, extension_context_id, extension_digest)
    REFERENCES semantic.context_extension (route, context_id, digest)
);
-- The head probe must not scan the table: it is empty until a Context has an extension, and the planner prefers a
-- sequential scan of an empty table, which would grow with the table.
CREATE FUNCTION semantic.context_extension_head(p_route integer, p_context_id uuid)
RETURNS TABLE (digest text, head integer)
LANGUAGE sql STABLE
SET enable_seqscan = off
AS $$
  SELECT activation.digest, activation.head
  FROM semantic.context_extension_activation activation
  WHERE activation.route = p_route AND activation.context_id = p_context_id
  ORDER BY activation.head DESC
  LIMIT 1
$$;

-- migrate:down
DROP FUNCTION semantic.context_extension_head(integer, uuid);
DROP TABLE semantic.release_composite;
DROP TABLE semantic.context_extension_activation;
DROP TABLE semantic.context_extension;
