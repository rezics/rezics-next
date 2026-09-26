-- Retain the exact source field used for a redirect or merge assertion. Existing
-- proposals remain historical; new changes need a complete retained observation.
ALTER TABLE source.record_identity_change ADD COLUMN evidence_pointer text
  CHECK (evidence_pointer IS NULL OR (length(evidence_pointer) BETWEEN 1 AND 200
    AND evidence_pointer LIKE '/%'));

CREATE OR REPLACE FUNCTION source.check_record_identity_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.evidence_pointer IS NULL OR NOT EXISTS (SELECT 1 FROM source.observation o
      JOIN source.record f ON f.id = o.record_id
      JOIN source.record t ON t.id = NEW.to_record_id
      WHERE o.id = NEW.observation_id AND o.principal_id = NEW.principal_id
        AND o.retention = 'retained' AND o.coverage->>'complete' = 'true'
        AND f.id = NEW.from_record_id AND t.provider = f.provider AND t.namespace = f.namespace) THEN
    RAISE EXCEPTION 'identity change needs complete retained provider evidence'
      USING ERRCODE = '23514', CONSTRAINT = 'record_identity_change_evidence';
  END IF;
  RETURN NEW;
END $$;
