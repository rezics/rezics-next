-- A private source observation can become unavailable without rewriting its
-- immutable evidence manifest. Each change advances an exact local head and
-- records invalidation in the same Content transaction.
ALTER TABLE verification.receipt DROP CONSTRAINT receipt_action_check;
ALTER TABLE verification.receipt ADD CONSTRAINT receipt_action_check CHECK (action IN
  ('origin.record', 'derivation.record', 'lineage.record', 'lineage.retract',
   'evidence.record', 'challenge.submit', 'challenge.resolve', 'source-disposition.record'));
ALTER TABLE verification.summary_generation DROP CONSTRAINT summary_generation_dependency_count_check;
ALTER TABLE verification.summary_generation ADD CONSTRAINT summary_generation_dependency_count_check
  CHECK (dependency_count BETWEEN 1 AND 128);
ALTER TABLE verification.summary_dependency DROP CONSTRAINT summary_dependency_ordinal_check;
ALTER TABLE verification.summary_dependency ADD CONSTRAINT summary_dependency_ordinal_check
  CHECK (ordinal BETWEEN 0 AND 127);

CREATE TABLE verification.observation_disposition (
  id uuid PRIMARY KEY,
  observation_id uuid NOT NULL REFERENCES source.observation(id),
  predecessor uuid REFERENCES verification.observation_disposition(id),
  state text NOT NULL CHECK (state IN ('available', 'inaccessible', 'withdrawn')),
  reason verification.note NOT NULL,
  operation_id uuid NOT NULL UNIQUE REFERENCES verification.receipt(id) DEFERRABLE INITIALLY DEFERRED,
  principal_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (observation_id, id)
);
CREATE INDEX observation_disposition_history ON verification.observation_disposition
  (observation_id, created_at, id);
CREATE TRIGGER observation_disposition_immutable BEFORE UPDATE OR DELETE
  ON verification.observation_disposition FOR EACH ROW EXECUTE FUNCTION verification.no_mutation();

CREATE TABLE verification.observation_disposition_head (
  observation_id uuid PRIMARY KEY REFERENCES source.observation(id),
  head uuid NOT NULL,
  FOREIGN KEY (observation_id, head) REFERENCES verification.observation_disposition(observation_id, id)
);
CREATE FUNCTION verification.observation_disposition_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM verification.record_invalidation('source-disposition', NEW.observation_id::text,
    NEW.head::text, 'source-disposition:' || NEW.head);
  RETURN NULL;
END $$;
CREATE TRIGGER observation_disposition_invalidation AFTER INSERT OR UPDATE OF head
  ON verification.observation_disposition_head FOR EACH ROW
  EXECUTE FUNCTION verification.observation_disposition_changed();
