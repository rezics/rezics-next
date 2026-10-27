-- migrate:up
CREATE INDEX revision_identity_version
  ON semantic.revision (route, subject_id, revision DESC)
  INCLUDE (recorded_transaction_id)
  WHERE kind IN ('create', 'identity');

-- migrate:down
DROP INDEX semantic.revision_identity_version;
