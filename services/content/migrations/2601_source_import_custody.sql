-- An import owns a private observation, not every observation of its provider.
-- Structure imports retain a resource input (the exact source Structure revision
-- is its anchor); Content imports bind only the exact derived Content revision.
CREATE TABLE source.import_custody (
  observation_id uuid NOT NULL REFERENCES source.observation(id),
  resource_id text NOT NULL CHECK (length(resource_id) BETWEEN 1 AND 2048),
  revision_id text NOT NULL CHECK (length(revision_id) BETWEEN 1 AND 2048),
  content_revision_id uuid REFERENCES content.revision(id),
  PRIMARY KEY (observation_id, revision_id),
  CHECK (content_revision_id IS NULL OR revision_id = content_revision_id::text)
);
CREATE INDEX import_custody_resource ON source.import_custody (resource_id, content_revision_id);

-- Preserve the established resource custody of already retained file imports.
-- This is the only provider-specific translation; all live readers use custody.
INSERT INTO source.import_custody (observation_id, resource_id, revision_id)
SELECT o.id, s.external_id, COALESCE(o.source_revision, o.id::text)
FROM source.observation o JOIN source.record s ON s.id = o.record_id
WHERE s.provider = 'rezics' AND s.namespace = 'recipe-file';

-- Collection Content carries an owner-issued private-import provenance proof.
-- Backfill imports made before explicit custody was recorded, too.
INSERT INTO source.import_custody (observation_id, resource_id, revision_id, content_revision_id)
SELECT o.id, v.resource_id, r.id::text, r.id
FROM source.observation o JOIN content.revision r
  ON r.source_revision = 'https://rezics.com/id/' || o.id::text
JOIN content.variant v ON v.id = r.variant_id
WHERE r.provenance->>'kind' = 'admitted-private-import-v1'
  AND r.provenance->>'sourceObservation' = 'https://rezics.com/id/' || o.id::text
  AND r.provenance->>'sourceDigest' = o.byte_digest
  AND NOT EXISTS (SELECT 1 FROM source.import_custody existing WHERE existing.observation_id = o.id)
  -- Evidence already imported into independent resources has shared custody.
  -- Do not arbitrarily assign it to one resource's destructive erasure.
  AND NOT EXISTS (
    SELECT 1 FROM content.revision other
    JOIN content.variant ov ON ov.id = other.variant_id
    WHERE other.source_revision = r.source_revision AND ov.resource_id <> v.resource_id
      AND other.provenance->>'kind' = 'admitted-private-import-v1'
      AND other.provenance->>'sourceObservation' = r.source_revision
      AND other.provenance->>'sourceDigest' = o.byte_digest
  )
ON CONFLICT DO NOTHING;

CREATE FUNCTION source.import_custody_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'immutable source import custody' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM source.import_custody c
    WHERE c.observation_id = NEW.observation_id AND c.resource_id <> NEW.resource_id) THEN
    RAISE EXCEPTION 'source import custody changed resource' USING ERRCODE = '23514';
  END IF;
  IF NEW.content_revision_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM content.revision r
    JOIN content.variant v ON v.id = r.variant_id
    JOIN source.observation o ON o.id = NEW.observation_id
    WHERE r.id = NEW.content_revision_id AND v.resource_id = NEW.resource_id
      AND o.source_erasure_id IS NULL
      AND r.source_revision = 'https://rezics.com/id/' || o.id::text
      AND r.provenance->>'kind' = 'admitted-private-import-v1'
      AND r.provenance->>'sourceObservation' = 'https://rezics.com/id/' || o.id::text
      AND r.provenance->>'sourceDigest' = o.byte_digest
  ) THEN
    RAISE EXCEPTION 'source import custody differs from the owner revision' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER source_import_custody_immutable BEFORE INSERT OR UPDATE OR DELETE ON source.import_custody
  FOR EACH ROW EXECUTE FUNCTION source.import_custody_guard();

-- Only the established erasure transition may redact an observation, and only
-- after a revision in its explicit custody carries the same journal marker.
CREATE OR REPLACE FUNCTION source.observation_erasure_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.retention <> 'retained' OR OLD.raw_bytes IS NULL OR OLD.byte_digest IS NULL
    OR OLD.source_erasure_id IS NOT NULL OR OLD.source_erasure_epoch IS NOT NULL
    OR NEW.retention <> 'not-retained' OR NEW.raw_bytes IS NOT NULL OR NEW.byte_digest IS NOT NULL
    OR NEW.source_erasure_id IS NULL OR NEW.source_erasure_epoch IS NULL OR NEW.source_erasure_epoch < 1
    OR (to_jsonb(OLD) - 'retention' - 'raw_bytes' - 'byte_digest' - 'source_erasure_id' - 'source_erasure_epoch')
       IS DISTINCT FROM (to_jsonb(NEW) - 'retention' - 'raw_bytes' - 'byte_digest' - 'source_erasure_id' - 'source_erasure_epoch')
    OR NOT EXISTS (
      SELECT 1
      FROM source.import_custody c
      JOIN content.variant v ON v.resource_id = c.resource_id
      JOIN content.revision r ON r.variant_id = v.id
        AND (c.content_revision_id IS NULL OR c.content_revision_id = r.id)
      JOIN content.revision_erasure e ON e.revision_id = r.id
      WHERE c.observation_id = OLD.id
        AND r.availability = 'erased'
        AND e.erasure_id = NEW.source_erasure_id
        AND e.erasure_epoch = NEW.source_erasure_epoch
    ) THEN
    RAISE EXCEPTION 'immutable source evidence' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER source_observation_immutable ON source.observation;
CREATE TRIGGER source_observation_immutable BEFORE UPDATE OR DELETE ON source.observation
  FOR EACH ROW EXECUTE FUNCTION source.observation_erasure_guard();

-- Keep the established journal owner and evidence-item return count. Custody,
-- rather than a provider's identity convention, selects retained import bytes.
CREATE OR REPLACE FUNCTION verification.erase_evidence_sources(revision_ids uuid[], erasure uuid, epoch bigint)
RETURNS integer
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  updated integer;
  repaired integer;
BEGIN
  IF erasure IS NULL OR epoch IS NULL OR epoch < 1 OR revision_ids IS NULL
     OR cardinality(revision_ids) > 256 THEN
    RAISE EXCEPTION 'evidence source erasure journal identity is invalid' USING ERRCODE = '23514';
  END IF;
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'evidence source erasure needs read committed' USING ERRCODE = '25000';
  END IF;
  PERFORM 1 FROM content.revision
    WHERE id = ANY (revision_ids)
    ORDER BY id
    FOR UPDATE;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.unnest(revision_ids) AS requested(id)
    WHERE NOT EXISTS (
      SELECT 1
      FROM content.revision_erasure e
      JOIN content.revision r ON r.id = e.revision_id
      WHERE e.revision_id = requested.id
        AND r.availability = 'erased'
        AND e.erasure_id = erasure
        AND e.erasure_epoch = epoch
    )
  ) THEN
    RAISE EXCEPTION 'evidence source erasure journal does not match the revision tombstone'
      USING ERRCODE = '23514';
  END IF;
  UPDATE verification.evidence_item
    SET selector = verification.evidence_selector_retained(selector),
        source_terminal = true,
        source_erasure_id = erasure,
        source_erasure_epoch = epoch
    WHERE content_revision_id = ANY (revision_ids)
      AND NOT source_terminal
      AND verification.evidence_selector_has_source(selector);
  GET DIAGNOSTICS updated = ROW_COUNT;
  UPDATE verification.evidence_item
    SET selector = verification.evidence_selector_retained(selector),
        source_erasure_id = erasure,
        source_erasure_epoch = epoch
    WHERE content_revision_id = ANY (revision_ids)
      AND source_terminal
      AND verification.evidence_selector_has_source(selector);
  GET DIAGNOSTICS repaired = ROW_COUNT;

  UPDATE source.observation o
    SET retention = 'not-retained', raw_bytes = NULL, byte_digest = NULL,
        source_erasure_id = erasure, source_erasure_epoch = epoch
    WHERE o.retention = 'retained'
      AND o.raw_bytes IS NOT NULL
      AND o.source_erasure_id IS NULL
      AND o.source_erasure_epoch IS NULL
      AND EXISTS (
        SELECT 1
        FROM source.import_custody c
        JOIN content.variant v ON v.resource_id = c.resource_id
        JOIN content.revision r ON r.variant_id = v.id
          AND (c.content_revision_id IS NULL OR c.content_revision_id = r.id)
        WHERE c.observation_id = o.id
          AND r.id = ANY (revision_ids)
      );

  RETURN updated + repaired;
END $$;

-- Retained import bytes count as open source until the journaled owner clears them.
CREATE OR REPLACE FUNCTION verification.open_evidence_source_revisions(revision_ids uuid[])
RETURNS TABLE (revision_id uuid)
LANGUAGE plpgsql STABLE
SET search_path = pg_catalog
AS $$
BEGIN
  IF revision_ids IS NULL OR cardinality(revision_ids) > 256 THEN
    RAISE EXCEPTION 'evidence source probe exceeds its bound' USING ERRCODE = '23514';
  END IF;
  RETURN QUERY
  SELECT r.id
  FROM content.revision r
  WHERE r.id = ANY (revision_ids)
    AND (
      EXISTS (
        SELECT 1 FROM verification.evidence_item i
        WHERE i.content_revision_id = r.id
          AND NOT i.source_terminal
          AND verification.evidence_selector_has_source(i.selector)
      )
      OR EXISTS (
        SELECT 1 FROM verification.evidence_item i
        WHERE i.content_revision_id = r.id
          AND i.source_terminal
          AND verification.evidence_selector_has_source(i.selector)
      )
      OR EXISTS (
        SELECT 1
        FROM content.variant v
        JOIN source.import_custody c ON c.resource_id = v.resource_id
          AND (c.content_revision_id IS NULL OR c.content_revision_id = r.id)
        JOIN source.observation o ON o.id = c.observation_id
        WHERE v.id = r.variant_id
          AND o.retention = 'retained'
          AND o.raw_bytes IS NOT NULL
      )
    )
  ORDER BY 1;
END $$;
