CREATE TABLE reader.library_loan (
  agent text NOT NULL,
  id text NOT NULL,
  copy text NOT NULL,
  state jsonb NOT NULL,
  due_at timestamptz NOT NULL,
  returned_at timestamptz,
  version bigint NOT NULL CHECK (version > 0),
  PRIMARY KEY (agent, id),
  FOREIGN KEY (agent, copy) REFERENCES reader.library_copy (agent, id) ON DELETE CASCADE,
  CHECK (id ~ '^https://rezics.com/id/[0-9a-f-]{36}$')
);
-- A copy can be in only one active loan; both directions share the same slot.
CREATE UNIQUE INDEX library_loan_active_copy ON reader.library_loan (agent, copy) WHERE returned_at IS NULL;
-- The FK cascade must find returned history too; the active slot cannot serve it.
CREATE INDEX library_loan_copy ON reader.library_loan (agent, copy);
CREATE INDEX library_loan_due ON reader.library_loan (agent, due_at, id);
CREATE INDEX library_loan_active_due ON reader.library_loan (agent, due_at, id) WHERE returned_at IS NULL;
CREATE TRIGGER library_bundle_loans AFTER INSERT OR UPDATE OR DELETE ON reader.library_loan
  FOR EACH ROW EXECUTE FUNCTION reader.advance_library_bundle_fence();
