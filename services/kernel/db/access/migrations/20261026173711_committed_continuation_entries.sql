-- migrate:up
ALTER TABLE access.committed_continuation
  DROP CONSTRAINT committed_continuation_check3,
  ADD CONSTRAINT committed_continuation_lifetime_check
    CHECK (committed_expires_at > created_at AND committed_expires_at <= created_at + interval '300 seconds');
-- A root can record a native business receipt from an operated account's route,
-- or a core command receipt whose transaction UUID does not encode a route.
ALTER TABLE access.committed_continuation_completion
  DROP CONSTRAINT committed_continuation_completion_check1,
  ADD COLUMN receipt_key text CHECK (length(receipt_key) BETWEEN 1 AND 256),
  ADD COLUMN receipt_digest text CHECK (receipt_digest ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT committed_continuation_business_receipt_check
    CHECK ((receipt_key IS NULL) = (receipt_digest IS NULL));
CREATE TABLE access.committed_continuation_entry (
  route integer NOT NULL,
  continuation_id uuid NOT NULL,
  step text NOT NULL CHECK (step ~ '^[a-z][a-z0-9-]{0,63}$'),
  target text NOT NULL CHECK (length(target) BETWEEN 1 AND 128),
  key text NOT NULL CHECK (length(key) BETWEEN 1 AND 240),
  digest text NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (route, continuation_id, step, target, key),
  FOREIGN KEY (route, continuation_id) REFERENCES access.committed_continuation (route, continuation_id)
);
CREATE TRIGGER committed_continuation_entry_immutable
  BEFORE UPDATE OR DELETE ON access.committed_continuation_entry
  FOR EACH ROW EXECUTE FUNCTION access.committed_continuation_completion_immutable();
INSERT INTO access.committed_continuation_entry (route, continuation_id, step, target, key, digest)
SELECT page.route, page.continuation_id, entry->>'step', entry->>'target', entry->>'key', entry->>'digest'
FROM access.operator_fence_page page CROSS JOIN LATERAL jsonb_array_elements(page.allowlist) entry;
-- migrate:down
DROP TABLE access.committed_continuation_entry;
ALTER TABLE access.committed_continuation_completion
  DROP CONSTRAINT committed_continuation_business_receipt_check,
  DROP COLUMN receipt_key,
  DROP COLUMN receipt_digest,
  ADD CONSTRAINT committed_continuation_completion_check1
    CHECK (route = get_byte(uuid_send(receipt_id), 10) * 256 + get_byte(uuid_send(receipt_id), 11));
ALTER TABLE access.committed_continuation
  DROP CONSTRAINT committed_continuation_lifetime_check,
  ADD CONSTRAINT committed_continuation_check3 CHECK (committed_expires_at = created_at + interval '300 seconds');
