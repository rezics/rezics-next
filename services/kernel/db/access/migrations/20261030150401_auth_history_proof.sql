-- migrate:up
-- One immutable fact per phase/barrier. Neither phase is a participant ACK.
CREATE TABLE access.auth_history_proof (
  route integer NOT NULL,
  account_id uuid NOT NULL,
  phase text NOT NULL CHECK (phase IN ('native-consumed','copies-erased')),
  version integer NOT NULL CHECK (version > 0),
  at timestamptz NOT NULL,
  continuation_id uuid,
  receipt_id uuid,
  PRIMARY KEY (route,account_id,phase),
  FOREIGN KEY (route,account_id) REFERENCES access.erasure(route,account_id),
  CHECK (route BETWEEN 0 AND 65535),
  CHECK (route=((get_byte(uuid_send(account_id),10)*256)+get_byte(uuid_send(account_id),11))),
  CHECK ((phase='native-consumed' AND continuation_id IS NOT NULL AND receipt_id IS NOT NULL)
      OR (phase='copies-erased' AND continuation_id IS NULL AND receipt_id IS NULL))
);
CREATE TRIGGER auth_history_proof_immutable BEFORE UPDATE OR DELETE ON access.auth_history_proof
  FOR EACH ROW EXECUTE FUNCTION access.committed_continuation_completion_immutable();
CREATE UNIQUE INDEX committed_continuation_auth_source ON access.committed_continuation
  (route,account_id,barrier_receipt_id) WHERE allowlist @> '[{"step":"erase-auth-owner"}]'::jsonb;

-- migrate:down
DROP INDEX access.committed_continuation_auth_source;
DROP TABLE access.auth_history_proof;
