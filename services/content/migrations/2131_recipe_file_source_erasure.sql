ALTER TABLE source.observation
  ADD COLUMN source_erasure_id uuid,
  ADD COLUMN source_erasure_epoch bigint,
  ADD CONSTRAINT source_observation_erasure_marker CHECK (
    (source_erasure_id IS NULL AND source_erasure_epoch IS NULL)
    OR (retention = 'not-retained' AND raw_bytes IS NULL AND byte_digest IS NULL
      AND source_erasure_id IS NOT NULL AND source_erasure_epoch IS NOT NULL AND source_erasure_epoch >= 1)
  );

-- The existing source erasure owner may redact retained Recipe file bytes only
-- after the Work's Content revision carries the same erasure journal marker.
CREATE FUNCTION source.observation_erasure_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.retention <> 'retained' OR OLD.raw_bytes IS NULL OR OLD.byte_digest IS NULL
    OR OLD.source_erasure_id IS NOT NULL OR OLD.source_erasure_epoch IS NOT NULL
    OR NEW.retention <> 'not-retained' OR NEW.raw_bytes IS NOT NULL OR NEW.byte_digest IS NOT NULL
    OR NEW.source_erasure_id IS NULL OR NEW.source_erasure_epoch IS NULL OR NEW.source_erasure_epoch < 1
    OR (to_jsonb(OLD) - 'retention' - 'raw_bytes' - 'byte_digest' - 'source_erasure_id' - 'source_erasure_epoch')
       IS DISTINCT FROM (to_jsonb(NEW) - 'retention' - 'raw_bytes' - 'byte_digest' - 'source_erasure_id' - 'source_erasure_epoch')
    OR NOT EXISTS (
      SELECT 1
      FROM source.record s
      JOIN content.variant v ON v.resource_id = s.external_id
      JOIN content.revision r ON r.variant_id = v.id
      JOIN content.revision_erasure e ON e.revision_id = r.id
      WHERE s.id = OLD.record_id
        AND s.provider = 'rezics'
        AND s.namespace = 'recipe-file'
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

-- Extend the established erasure owner so each erased Work also loses retained
-- Recipe file payloads registered against that Work. The return count remains
-- the evidence-item count consumed by existing callers.
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
        FROM source.record s
        JOIN content.variant v ON v.resource_id = s.external_id
        JOIN content.revision r ON r.variant_id = v.id
        WHERE s.id = o.record_id
          AND s.provider = 'rezics'
          AND s.namespace = 'recipe-file'
          AND r.id = ANY (revision_ids)
      );

  RETURN updated + repaired;
END $$;

-- Retained Recipe bytes count as open source until the journaled owner clears them.
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
        JOIN source.record s ON s.external_id = v.resource_id
          AND s.provider = 'rezics' AND s.namespace = 'recipe-file'
        JOIN source.observation o ON o.record_id = s.id
        WHERE v.id = r.variant_id
          AND o.retention = 'retained'
          AND o.raw_bytes IS NOT NULL
      )
    )
  ORDER BY 1;
END $$;
