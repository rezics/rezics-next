-- Preserve the audit rows while allowing a later decision to suppress the same
-- bytes again. A lift covers one suppression, never all future rows for a digest.
ALTER TABLE media.suppressed_digest ADD COLUMN id uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN case_id uuid, ADD COLUMN decision_id uuid;
ALTER TABLE media.suppressed_digest DROP CONSTRAINT suppressed_digest_pkey;
ALTER TABLE media.suppressed_digest ADD PRIMARY KEY (id);
CREATE INDEX suppressed_digest_lookup ON media.suppressed_digest (digest, id);
CREATE UNIQUE INDEX suppressed_digest_decision ON media.suppressed_digest (decision_id, digest)
  WHERE decision_id IS NOT NULL;

CREATE TABLE media.suppression_lift (
  suppression_id uuid PRIMARY KEY REFERENCES media.suppressed_digest(id),
  case_id uuid NOT NULL,
  decision_id uuid NOT NULL,
  operation_id text NOT NULL REFERENCES content.receipt(operation_id),
  lifted_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER suppression_lift_immutable BEFORE UPDATE OR DELETE ON media.suppression_lift
  FOR EACH ROW EXECUTE FUNCTION content.no_mutation();
CREATE FUNCTION media.check_suppression_lift() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM media.suppressed_digest d
    JOIN content.receipt r ON r.operation_id = NEW.operation_id
    JOIN content.outbox o ON o.operation_id = r.operation_id
    WHERE d.id = NEW.suppression_id AND d.case_id = NEW.case_id
      AND r.action = 'media.screen.review' AND r.outcome = 'succeeded'
      AND o.recipe = 'media-v1' AND o.event_type = 'media.screen.reviewed'
      AND o.payload->>'suppressed' = 'false'
      AND o.payload->'lift'->>'id' = d.id::text
      AND o.payload->'lift'->>'caseId' = NEW.case_id::text
      AND o.payload->'lift'->>'decisionId' = NEW.decision_id::text
      AND o.payload->'lift'->>'reversesDecisionId' = d.decision_id::text) THEN
    RAISE EXCEPTION 'suppression lift requires its upheld appeal receipt' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER suppression_lift_basis BEFORE INSERT ON media.suppression_lift
  FOR EACH ROW EXECUTE FUNCTION media.check_suppression_lift();

CREATE FUNCTION media.digest_suppressed(original_digest text) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM media.suppressed_digest d WHERE d.digest = original_digest
    AND NOT EXISTS (SELECT 1 FROM media.suppression_lift l WHERE l.suppression_id = d.id))
$$;
CREATE OR REPLACE FUNCTION media.check_suppressed_original() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind = 'original' THEN
    NEW.clearance = 'screening'; NEW.clearance_reason = NULL;
    PERFORM pg_advisory_xact_lock(hashtextextended('media-copy:' || NEW.byte_digest, 0));
    IF media.digest_suppressed(NEW.byte_digest) THEN
      NEW.clearance = 'rejected'; NEW.clearance_reason = 'identical-copy-suppressed';
    END IF;
  ELSE
    SELECT clearance, clearance_reason INTO NEW.clearance, NEW.clearance_reason
      FROM media.representation WHERE id = NEW.source_id;
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION media.delivery_clearance(p media.representation) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN media.digest_suppressed(o.byte_digest) THEN 'rejected' ELSE o.clearance END
    FROM media.representation o
    WHERE o.id = CASE WHEN p.kind = 'original' THEN p.id ELSE p.source_id END
      AND o.kind = 'original'
$$;
