-- A reader's Saved Filters: named FilterDocuments with their exact Facet
-- DefinitionRefs, private to the verified person principal, and the order of
-- those pinned as Home tabs (docs/contracts/queries.md#concepts-and-value-pages).
-- Following a Concept follows its one-Condition Filter, so the follow row owns
-- that filter's life: the trigger below creates it (pinned while a tab is free)
-- and removes it in the follow's own transaction.
CREATE TABLE access.saved_filter_inventory (
  principal_id uuid PRIMARY KEY REFERENCES access.principal(id) ON DELETE CASCADE,
  revision uuid NOT NULL,
  -- Filters a reader names; a followed Concept's filter is bounded by follows instead.
  named_count integer NOT NULL DEFAULT 0 CHECK (named_count BETWEEN 0 AND 50)
);

CREATE TABLE access.saved_filter (
  id uuid PRIMARY KEY,
  principal_id uuid NOT NULL REFERENCES access.principal(id) ON DELETE CASCADE,
  -- Null only for a followed Concept's filter, which reads as the Concept's own label.
  name text CHECK (name IS NULL OR (length(name) BETWEEN 1 AND 80 AND name = btrim(name)
    AND name !~ '[[:cntrl:]]')),
  -- The Query definition revision the Filter was admitted under (model/definitions); a new revision
  -- widens this CHECK in a later migration rather than rereading stored filters.
  profile text NOT NULL DEFAULT 'filter-document-v2' CHECK (profile = 'filter-document-v2'),
  document jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object' AND octet_length(document::text) <= 8192),
  facets text[] NOT NULL CHECK (cardinality(facets) BETWEEN 1 AND 32),
  -- Saved Filters read the Global Context until Realm Context revisions are retained with them.
  context text NOT NULL CHECK (context = 'global'),
  concept text CHECK (concept IS NULL OR concept ~ '^https://rezics[.]com/id/[0-9a-f-]{36}$'),
  -- Home tab order after Following and All; null when not pinned. Positions stay contiguous.
  pin_position smallint CHECK (pin_position IS NULL OR pin_position BETWEEN 0 AND 7),
  revision uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (concept IS NOT NULL OR name IS NOT NULL),
  CONSTRAINT saved_filter_concept UNIQUE (principal_id, concept),
  CONSTRAINT saved_filter_pin UNIQUE (principal_id, pin_position) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX saved_filter_listing ON access.saved_filter
  (principal_id, pin_position, created_at DESC, id);

CREATE TABLE access.saved_filter_receipt (
  principal_id uuid NOT NULL REFERENCES access.principal(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  result jsonb NOT NULL,
  PRIMARY KEY (principal_id, idempotency_key)
);
CREATE TRIGGER saved_filter_receipt_immutable BEFORE UPDATE ON access.saved_filter_receipt
  FOR EACH ROW EXECUTE FUNCTION access.home_receipt_immutable();

-- The document is the Concept Facet's one-Condition Filter with its exact
-- DefinitionRef; services/main/tests/saved-filter.test.ts holds it equal to
-- `conceptFilter` in modules/concept-page/contract.ts. A new Concept Facet
-- version changes it only through a new migration.
CREATE FUNCTION access.saved_filter_concept_document(concept text) RETURNS jsonb
  LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object('all', jsonb_build_array(jsonb_build_object(
    'facet', 'https://rezics.com/definition/facet-concept-v1', 'any', jsonb_build_array(concept))))
$$;

CREATE FUNCTION access.saved_filter_follow() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  slot smallint;
  removed smallint;
BEGIN
  IF NEW.following AND (TG_OP = 'INSERT' OR NOT OLD.following) THEN
    INSERT INTO access.saved_filter_inventory (principal_id, revision)
      VALUES (NEW.principal_id, gen_random_uuid()) ON CONFLICT (principal_id) DO NOTHING;
    PERFORM 1 FROM access.saved_filter_inventory WHERE principal_id = NEW.principal_id FOR UPDATE;
    IF NOT EXISTS (SELECT 1 FROM access.saved_filter
        WHERE principal_id = NEW.principal_id AND concept = NEW.target) THEN
      SELECT CASE WHEN count(*) < 8 THEN count(*)::smallint END INTO slot FROM access.saved_filter
        WHERE principal_id = NEW.principal_id AND pin_position IS NOT NULL;
      INSERT INTO access.saved_filter (id, principal_id, name, document, facets, context, concept,
        pin_position, revision)
      VALUES (gen_random_uuid(), NEW.principal_id, NULL, access.saved_filter_concept_document(NEW.target),
        ARRAY['https://rezics.com/definition/facet-concept-v1'], 'global', NEW.target, slot, gen_random_uuid());
      UPDATE access.saved_filter_inventory SET revision = gen_random_uuid()
        WHERE principal_id = NEW.principal_id;
    END IF;
  ELSIF TG_OP = 'UPDATE' AND OLD.following AND NOT NEW.following THEN
    PERFORM 1 FROM access.saved_filter_inventory WHERE principal_id = NEW.principal_id FOR UPDATE;
    DELETE FROM access.saved_filter WHERE principal_id = NEW.principal_id AND concept = NEW.target
      RETURNING pin_position INTO removed;
    IF FOUND THEN
      IF removed IS NOT NULL THEN
        UPDATE access.saved_filter SET pin_position = pin_position - 1
          WHERE principal_id = NEW.principal_id AND pin_position > removed;
      END IF;
      UPDATE access.saved_filter_inventory SET revision = gen_random_uuid()
        WHERE principal_id = NEW.principal_id;
    END IF;
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER follow_concept_saved_filter AFTER INSERT OR UPDATE OF following ON access.follow
  FOR EACH ROW WHEN (NEW.kind = 'concept') EXECUTE FUNCTION access.saved_filter_follow();

-- Concept follows made before this migration get their filters, pinned in target order while tabs are free.
INSERT INTO access.saved_filter_inventory (principal_id, revision)
  SELECT principal_id, gen_random_uuid() FROM (SELECT DISTINCT principal_id FROM access.follow
    WHERE kind = 'concept' AND following) followers
  ON CONFLICT (principal_id) DO NOTHING;
INSERT INTO access.saved_filter (id, principal_id, name, document, facets, context, concept, pin_position, revision)
  SELECT gen_random_uuid(), principal_id, NULL, access.saved_filter_concept_document(target),
    ARRAY['https://rezics.com/definition/facet-concept-v1'], 'global', target,
    CASE WHEN ordinal < 8 THEN ordinal::smallint END, gen_random_uuid()
  FROM (SELECT principal_id, target, row_number() OVER (PARTITION BY principal_id ORDER BY target) - 1 AS ordinal
    FROM access.follow WHERE kind = 'concept' AND following) followed
  ON CONFLICT (principal_id, concept) DO NOTHING;
