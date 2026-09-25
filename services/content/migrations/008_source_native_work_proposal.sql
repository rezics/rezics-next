CREATE TABLE source.native_work_proposal (
  id uuid PRIMARY KEY,
  conversion_id uuid NOT NULL REFERENCES source.conversion(id),
  observation_id uuid NOT NULL REFERENCES source.observation(id),
  record_id uuid NOT NULL REFERENCES source.record(id),
  principal_id uuid NOT NULL,
  source_digest text NOT NULL CHECK (source_digest ~ '^[0-9a-f]{64}$'),
  candidate_title text NOT NULL CHECK (length(candidate_title) BETWEEN 1 AND 200
    AND candidate_title !~ '[[:cntrl:]]'),
  rights_evidence jsonb NOT NULL CHECK (jsonb_typeof(rights_evidence) = 'object'),
  graph_receipt text NOT NULL CHECK (graph_receipt ~ '^urn:rezics:receipt:source-projection:[0-9a-f]{64}$'),
  graph_data_epoch uuid NOT NULL,
  graph_sequence numeric(38, 0) NOT NULL CHECK (graph_sequence >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (conversion_id)
);
CREATE INDEX native_work_proposal_principal_idx ON source.native_work_proposal (principal_id, id);
CREATE TRIGGER source_native_work_proposal_immutable
  BEFORE UPDATE OR DELETE ON source.native_work_proposal
  FOR EACH ROW EXECUTE FUNCTION source.no_mutation();
