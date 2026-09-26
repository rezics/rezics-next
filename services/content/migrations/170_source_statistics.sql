-- Imported scores and provider user keys remain source evidence. No native
-- Rating ballot, Account principal, target identity or grant can be stored here.
CREATE TABLE source.statistic (
  id uuid PRIMARY KEY,
  principal_id uuid NOT NULL,
  record_id uuid NOT NULL REFERENCES source.record(id),
  observation_id uuid NOT NULL REFERENCES source.observation(id),
  kind text NOT NULL CHECK (kind IN ('aggregate-score', 'provider-user-score')),
  score_pointer text NOT NULL CHECK (length(score_pointer) BETWEEN 1 AND 200),
  user_pointer text CHECK (length(user_pointer) BETWEEN 1 AND 200),
  provider_user_key text CHECK (length(provider_user_key) BETWEEN 1 AND 200
    AND provider_user_key !~ '[[:cntrl:]]'),
  score numeric(18,6) NOT NULL CHECK (score BETWEEN -1000000000 AND 1000000000),
  observation_digest text NOT NULL CHECK (observation_digest ~ '^[0-9a-f]{64}$'),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9:_./-]{1,128}$'),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (principal_id, idempotency_key),
  UNIQUE NULLS NOT DISTINCT (observation_id, kind, score_pointer, user_pointer),
  CHECK ((kind = 'provider-user-score') = (user_pointer IS NOT NULL AND provider_user_key IS NOT NULL))
);
CREATE INDEX statistic_record_idx ON source.statistic (principal_id, record_id, created_at, id);
CREATE INDEX statistic_observation_idx ON source.statistic (observation_id, id);
CREATE TRIGGER source_statistic_immutable BEFORE UPDATE OR DELETE ON source.statistic
  FOR EACH ROW EXECUTE FUNCTION source.no_mutation();

CREATE FUNCTION source.check_statistic_capture() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM source.observation o WHERE o.id = NEW.observation_id
    AND o.principal_id = NEW.principal_id AND o.record_id = NEW.record_id
    AND o.retention = 'retained' AND o.byte_digest = NEW.observation_digest
    AND o.coverage->>'complete' = 'true') THEN
    RAISE EXCEPTION 'statistic needs exact complete retained observation'
      USING ERRCODE = '23514', CONSTRAINT = 'statistic_capture';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER source_statistic_capture BEFORE INSERT ON source.statistic
  FOR EACH ROW EXECUTE FUNCTION source.check_statistic_capture();
