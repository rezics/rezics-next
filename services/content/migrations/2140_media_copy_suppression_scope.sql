-- Imported covers stand on the importer's basis. A notice about those bytes
-- must not deny a user's separately claimed upload of the same file.
ALTER TABLE media.suppressed_digest ADD COLUMN scope text NOT NULL DEFAULT 'all'
  CHECK (scope IN ('all', 'imported-cover'));
ALTER TABLE media.suppression_lift ADD COLUMN scope text NOT NULL DEFAULT 'all'
  CHECK (scope IN ('all', 'imported-cover'));

CREATE OR REPLACE FUNCTION media.digest_suppressed(original_digest text, cover_only boolean)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM media.suppressed_digest d
    WHERE d.digest = original_digest AND (d.scope = 'all' OR cover_only)
      AND NOT EXISTS (SELECT 1 FROM media.suppression_lift l WHERE l.suppression_id = d.id))
$$;
-- Retained callers that have no asset purpose can only establish a global fence.
CREATE OR REPLACE FUNCTION media.digest_suppressed(original_digest text)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT media.digest_suppressed(original_digest, false)
$$;

CREATE OR REPLACE FUNCTION media.check_suppression_lift() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM media.suppressed_digest d
    JOIN content.receipt r ON r.operation_id = NEW.operation_id
    JOIN content.outbox o ON o.operation_id = r.operation_id
    WHERE d.id = NEW.suppression_id AND d.case_id = NEW.case_id AND d.scope = NEW.scope
      AND r.action = 'media.screen.review' AND r.outcome = 'succeeded'
      AND o.recipe = 'media-v1' AND o.event_type = 'media.screen.reviewed'
      AND o.payload->>'suppressed' = 'false'
      AND o.payload->'lift'->>'id' = d.id::text
      AND o.payload->'lift'->>'caseId' = NEW.case_id::text
      AND o.payload->'lift'->>'decisionId' = NEW.decision_id::text
      AND o.payload->'lift'->>'reversesDecisionId' = d.decision_id::text
      AND COALESCE(o.payload->'lift'->>'scope', 'all') = d.scope) THEN
    RAISE EXCEPTION 'suppression lift requires its scoped restoration receipt' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION media.check_suppressed_original() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind = 'original' THEN
    NEW.clearance = 'cleared'; NEW.clearance_reason = NULL;
    PERFORM pg_advisory_xact_lock(hashtextextended('media-copy:' || NEW.byte_digest, 0));
    IF media.digest_suppressed(NEW.byte_digest,
      (SELECT a.cover_only FROM media.asset a WHERE a.id = NEW.asset_id)) THEN
      NEW.clearance = 'rejected'; NEW.clearance_reason = 'identical-copy-suppressed';
    END IF;
  ELSE
    SELECT clearance, clearance_reason INTO NEW.clearance, NEW.clearance_reason
      FROM media.representation WHERE id = NEW.source_id;
  END IF;
  RETURN NEW;
END $$;

-- All delivery and rendition surfaces resolve the source's immutable purpose.
CREATE OR REPLACE FUNCTION media.delivery_clearance(p media.representation) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN o.availability <> 'available' OR media.digest_suppressed(o.byte_digest,a.cover_only)
    OR (o.clearance = 'rejected' AND o.clearance_reason = 'staff-rejected')
    THEN 'rejected' ELSE 'cleared' END FROM media.representation o
    JOIN media.asset a ON a.id = o.asset_id
    WHERE o.id = CASE WHEN p.kind = 'original' THEN p.id ELSE p.source_id END AND o.kind = 'original'
$$;
