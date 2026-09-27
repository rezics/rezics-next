-- Names are factual labels on external identities, never native Agent identity.
-- Immutable observations preserve acquisition evidence; a CAS head selects the
-- current label (or an explicit removal) independently of native author credits.
CREATE TABLE source.author_name_revision (
  id uuid PRIMARY KEY,
  author_key text NOT NULL CHECK (author_key ~ '^/authors/OL[1-9][0-9]{0,11}A$'),
  principal_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  request_digest text NOT NULL,
  predecessor uuid REFERENCES source.author_name_revision(id),
  observation_id uuid REFERENCES source.observation(id),
  provider_revision bigint CHECK (provider_revision >= 0),
  display_name text CHECK (length(display_name) BETWEEN 1 AND 200),
  reason text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (principal_id, idempotency_key),
  UNIQUE (author_key, id),
  CHECK ((observation_id IS NOT NULL AND reason IS NULL)
    OR (observation_id IS NULL AND display_name IS NULL AND length(reason) BETWEEN 1 AND 500))
);
CREATE TRIGGER author_name_revision_immutable BEFORE UPDATE OR DELETE ON source.author_name_revision
  FOR EACH ROW EXECUTE FUNCTION rights.no_mutation();
CREATE TABLE source.author_name_head (
  author_key text PRIMARY KEY,
  revision uuid NOT NULL,
  FOREIGN KEY (author_key, revision) REFERENCES source.author_name_revision(author_key, id)
);
-- Even an empty name search must fence newly matching names.
CREATE TABLE source.author_name_generation (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0)
);
INSERT INTO source.author_name_generation(id) VALUES (true);
