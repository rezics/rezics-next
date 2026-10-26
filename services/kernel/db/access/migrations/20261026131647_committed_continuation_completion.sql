-- migrate:up
CREATE TABLE access.committed_continuation_completion (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  continuation_id uuid NOT NULL,
  step text NOT NULL CHECK (step ~ '^[a-z][a-z0-9-]{0,63}$'),
  target text NOT NULL CHECK (length(target) BETWEEN 1 AND 128),
  key text NOT NULL CHECK (length(key) BETWEEN 1 AND 240),
  digest text NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
  receipt_id uuid NOT NULL,
  PRIMARY KEY (route, continuation_id, step, target, key),
  CHECK (route = get_byte(uuid_send(continuation_id), 10) * 256 + get_byte(uuid_send(continuation_id), 11)),
  CHECK (route = get_byte(uuid_send(receipt_id), 10) * 256 + get_byte(uuid_send(receipt_id), 11)),
  FOREIGN KEY (route, continuation_id) REFERENCES access.committed_continuation (route, continuation_id)
);
CREATE FUNCTION access.committed_continuation_completion_immutable() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Committed continuation completions are immutable';
END;
$$;
CREATE TRIGGER committed_continuation_completion_immutable
  BEFORE UPDATE OR DELETE ON access.committed_continuation_completion
  FOR EACH ROW EXECUTE FUNCTION access.committed_continuation_completion_immutable();
INSERT INTO access.committed_continuation_completion (route, continuation_id, step, target, key, digest, receipt_id)
SELECT continuation.route, continuation.continuation_id, entry->>'step', entry->>'target', entry->>'key',
       entry->>'digest', (entry->>'receiptId')::uuid
FROM access.committed_continuation AS continuation
CROSS JOIN LATERAL jsonb_array_elements(continuation.completions) AS entry;
-- migrate:down
DROP TABLE access.committed_continuation_completion;
DROP FUNCTION access.committed_continuation_completion_immutable();
