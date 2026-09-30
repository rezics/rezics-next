-- One principal-private attempt has an immutable exact target and creation order.
-- No legacy Library statuses are converted into fabricated attempts.
CREATE TABLE reader.consumption_session (
  id text PRIMARY KEY CHECK (id ~ '^https://rezics.com/id/[0-9a-f-]{36}$'),
  principal_issuer text NOT NULL,
  principal_subject text NOT NULL,
  agent text NOT NULL,
  work text NOT NULL,
  attempt_order bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  state jsonb NOT NULL CHECK (jsonb_typeof(state) = 'object'),
  version bigint NOT NULL CHECK (version > 0),
  CHECK ((state->>'id') = id AND (state->'target'->>'work') = work
    AND (state->>'version')::bigint = version),
  CHECK ((state->>'state') IN ('planned','active','paused','dnf','finished')),
  CHECK (((state->>'state') = 'finished') = ((state->>'completedAt') IS NOT NULL)),
  CHECK (jsonb_array_length(state->'selections') BETWEEN 1 AND 16
    AND jsonb_array_length(state->'locators') <= 16)
);
CREATE INDEX consumption_session_inventory ON reader.consumption_session
  (principal_issuer, principal_subject, agent, attempt_order DESC);
CREATE INDEX consumption_session_latest ON reader.consumption_session
  (principal_issuer, principal_subject, agent, work, attempt_order DESC);
ALTER TABLE reader.library_status ADD COLUMN session_projection text
  REFERENCES reader.consumption_session(id);

-- Materialized membership is bounded to the selections in one attempt, and
-- supports exact-target traversal without scanning JSON or a person's history.
CREATE TABLE reader.consumption_session_target (
  session text NOT NULL REFERENCES reader.consumption_session(id),
  principal_issuer text NOT NULL,
  principal_subject text NOT NULL,
  agent text NOT NULL,
  resource text NOT NULL,
  attempt_order bigint NOT NULL,
  PRIMARY KEY (session, resource)
);
CREATE INDEX consumption_session_target_inventory ON reader.consumption_session_target
  (principal_issuer, principal_subject, agent, resource, attempt_order DESC);

CREATE FUNCTION reader.consumption_session_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.id, OLD.principal_issuer, OLD.principal_subject, OLD.agent, OLD.work, OLD.attempt_order,
      OLD.state->'target', OLD.state->'createdAt') IS DISTINCT FROM
     (NEW.id, NEW.principal_issuer, NEW.principal_subject, NEW.agent, NEW.work, NEW.attempt_order,
      NEW.state->'target', NEW.state->'createdAt') THEN
    RAISE EXCEPTION 'immutable consumption attempt identity' USING ERRCODE = '23514';
  END IF;
  IF OLD.state->>'state' IN ('dnf','finished') AND NEW.state->>'state' <> OLD.state->>'state'
    OR OLD.state->>'completedAt' IS NOT NULL AND NEW.state->>'completedAt' IS DISTINCT FROM OLD.state->>'completedAt' THEN
    RAISE EXCEPTION 'terminal consumption attempt' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER consumption_session_identity BEFORE UPDATE ON reader.consumption_session
  FOR EACH ROW EXECUTE FUNCTION reader.consumption_session_identity_guard();
