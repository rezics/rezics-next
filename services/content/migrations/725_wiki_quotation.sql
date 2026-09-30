-- Applied quotations only. Validation/proposals never reserve or write budget.
-- The publication adapter serializes apply per Work and rechecks the current
-- versioned policy before inserting. Identity excludes account and Zone.
CREATE SCHEMA IF NOT EXISTS wiki;
CREATE TABLE wiki.quotation (
  work text NOT NULL CHECK (work ~ '^https://rezics[.]com/id/[0-9a-f-]{36}$'),
  representation_sha256 text NOT NULL CHECK (representation_sha256 ~ '^[0-9a-f]{64}$'),
  locator_digest text NOT NULL CHECK (locator_digest ~ '^[0-9a-f]{64}$'),
  quote_digest text NOT NULL CHECK (quote_digest ~ '^[0-9a-f]{64}$'),
  code_points integer NOT NULL CHECK (code_points BETWEEN 1 AND 200),
  policy_version integer NOT NULL CHECK (policy_version > 0),
  applied_receipt text NOT NULL CHECK (length(applied_receipt) BETWEEN 1 AND 2048),
  PRIMARY KEY (work, representation_sha256, locator_digest, quote_digest)
);
COMMENT ON TABLE wiki.quotation IS 'Work-wide applied quotation ledger; G-846 apply is the sole writer';
