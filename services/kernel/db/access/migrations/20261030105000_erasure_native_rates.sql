-- migrate:up
ALTER TABLE access.write_rate_counter ADD COLUMN account_id uuid;
ALTER TABLE access.write_rate_chunk ADD COLUMN account_id uuid;
CREATE INDEX erasure_write_rate_counter_account ON access.write_rate_counter(account_id, route, identity_digest, family);
CREATE INDEX erasure_write_rate_chunk_account ON access.write_rate_chunk(account_id, route, identity_digest, operation_id, chunk_index);

-- Old HMACs cannot be reverse-attributed. Empty pre-cutover stores establish
-- coverage; any legacy rows conservatively retain a concrete deployment gap.
-- This is deployment work, never an account-count or runtime erasure scan.
CREATE TABLE access.erasure_native_coverage (
  name text PRIMARY KEY CHECK (name = 'rate-account-binding'),
  covered boolean NOT NULL
);
INSERT INTO access.erasure_native_coverage(name, covered)
SELECT 'rate-account-binding',
  NOT EXISTS (SELECT 1 FROM access.write_rate_counter LIMIT 1)
  AND NOT EXISTS (SELECT 1 FROM access.write_rate_chunk LIMIT 1);
ALTER TABLE access.erasure_native_blocked DROP CONSTRAINT erasure_native_blocked_reason_check;
ALTER TABLE access.erasure_native_blocked ADD CONSTRAINT erasure_native_blocked_reason_check CHECK (reason IN (
  'handle-consumer', 'membership-terminal-consumer', 'organization-close-consumer',
  'verification-decision-consumer', 'verification-reversal-consumer', 'controller-transition-consumer', 'rating-controller-projection-custody',
    'organization-cursor-cutover', 'rate-binding-deployment-coverage',
  'auth-fence-release-witness-unavailable', 'continuation-barrier-consumer', 'deletion-local-consumer'
));

-- migrate:down
DO $$ BEGIN RAISE EXCEPTION 'Rate binding erasure is irreversible'; END $$;
