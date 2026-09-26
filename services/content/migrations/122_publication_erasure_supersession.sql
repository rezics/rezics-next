-- The settled publication proof remains immutable. This local record retires
-- its active pin only after the relay erasure and exact graph suppression are
-- durable. It is evidence for the existing erasure frontier, not a new one.
CREATE TABLE content.publication_erasure_supersession (
  operation_id text PRIMARY KEY REFERENCES content.publication_preparation(operation_id),
  revision_id uuid NOT NULL REFERENCES content.revision_erasure(revision_id),
  erasure_id uuid NOT NULL,
  erasure_epoch bigint NOT NULL CHECK (erasure_epoch >= 1),
  graph_receipt text NOT NULL CHECK (graph_receipt ~ '^urn:rezics:receipt:erasure-graph:[0-9a-f]{64}$'),
  graph_data_epoch text NOT NULL CHECK (length(graph_data_epoch) BETWEEN 1 AND 200),
  graph_sequence bigint NOT NULL CHECK (graph_sequence >= 1),
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX publication_erasure_supersession_revision_idx
  ON content.publication_erasure_supersession (revision_id, operation_id);
CREATE TRIGGER publication_erasure_supersession_immutable
  BEFORE UPDATE OR DELETE ON content.publication_erasure_supersession
  FOR EACH ROW EXECUTE FUNCTION content.no_mutation();

CREATE FUNCTION content.publication_erasure_supersession_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM content.publication_preparation p
      WHERE p.operation_id = NEW.operation_id AND p.revision_id = NEW.revision_id
        AND p.status = 'active' AND p.pin_active)
    OR NOT EXISTS (SELECT 1 FROM content.revision_erasure e
      WHERE e.revision_id = NEW.revision_id AND e.erasure_id = NEW.erasure_id
        AND e.erasure_epoch = NEW.erasure_epoch) THEN
    RAISE EXCEPTION 'active publication supersession requires its exact erasure'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER publication_erasure_supersession_exact
  AFTER INSERT ON content.publication_erasure_supersession
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION content.publication_erasure_supersession_guard();
