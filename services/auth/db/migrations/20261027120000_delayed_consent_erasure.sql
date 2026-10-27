-- migrate:up
-- Retain consent issuance authority until every access token issued before
-- account erasure has expired, then let Auth maintenance remove it in batches.
CREATE TABLE auth_consent_erasure (
  account_id text PRIMARY KEY,
  due_at timestamptz NOT NULL
);
CREATE INDEX auth_consent_erasure_due ON auth_consent_erasure (due_at, account_id);

-- migrate:down
DROP TABLE auth_consent_erasure;
