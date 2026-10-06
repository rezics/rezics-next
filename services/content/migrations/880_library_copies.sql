-- Private owner records; removed copies retain identity for historical loans and CAS.
CREATE TABLE reader.library_copy (
  agent text NOT NULL,
  id text NOT NULL,
  work text NOT NULL,
  release text NOT NULL,
  state jsonb NOT NULL,
  version bigint NOT NULL CHECK (version > 0),
  removed boolean NOT NULL DEFAULT false,
  PRIMARY KEY (agent, id),
  CHECK (agent ~ '^https://rezics.com/id/[0-9a-f-]{36}$'),
  CHECK (id ~ '^https://rezics.com/id/[0-9a-f-]{36}$'),
  CHECK (work ~ '^https://rezics.com/id/[0-9a-f-]{36}$'),
  CHECK (release ~ '^https://rezics.com/id/[0-9a-f-]{36}$')
);
CREATE INDEX library_copy_work ON reader.library_copy (agent, work, id) WHERE NOT removed;
CREATE TABLE reader.library_copy_loan_command (
  agent text NOT NULL,
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9:_./-]{1,128}$'),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  result jsonb NOT NULL,
  PRIMARY KEY (agent, idempotency_key)
);
CREATE TRIGGER library_bundle_copies AFTER INSERT OR UPDATE OR DELETE ON reader.library_copy
  FOR EACH ROW EXECUTE FUNCTION reader.advance_library_bundle_fence();
