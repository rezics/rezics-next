CREATE TABLE reader.edition_preference (
  principal_issuer text NOT NULL,
  principal_subject text NOT NULL,
  agent text NOT NULL,
  work text NOT NULL,
  choice jsonb NOT NULL CHECK (jsonb_typeof(choice) = 'object'),
  version bigint NOT NULL CHECK (version > 0),
  PRIMARY KEY (principal_issuer, principal_subject, agent, work)
);
CREATE TABLE reader.edition_preference_command (
  principal_issuer text NOT NULL,
  principal_subject text NOT NULL,
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9:_./-]{1,128}$'),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  result jsonb NOT NULL,
  PRIMARY KEY (principal_issuer, principal_subject, idempotency_key)
);
CREATE TRIGGER edition_preference_command_immutable BEFORE UPDATE OR DELETE
  ON reader.edition_preference_command FOR EACH ROW EXECUTE FUNCTION content.no_mutation();
