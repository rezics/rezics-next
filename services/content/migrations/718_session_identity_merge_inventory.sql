-- Source-wide inventory is independent of any reader's private shelf. The
-- exact attempt target stays immutable when catalogue identities merge.
CREATE INDEX consumption_session_merge_inventory ON reader.consumption_session
  (work, id COLLATE "C");
CREATE INDEX consumption_session_selection_merge_inventory ON reader.consumption_session_target
  (resource, session COLLATE "C");

CREATE TABLE reader.consumption_session_merge_receipt (
  command_key text PRIMARY KEY CHECK (command_key ~ '^merge:[0-9a-f]{64}$'),
  task_key text NOT NULL,
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  session text NOT NULL REFERENCES reader.consumption_session(id),
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'
    AND octet_length(result::text) <= 65536
    AND (result->>'outcome') IS NOT DISTINCT FROM 'retained'
    AND (result->>'commandKey') IS NOT DISTINCT FROM command_key
    AND (result->>'receipt') IS NOT DISTINCT FROM ('urn:rezics:session:' || command_key)),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER consumption_session_merge_receipt_immutable BEFORE UPDATE OR DELETE
  ON reader.consumption_session_merge_receipt FOR EACH ROW EXECUTE FUNCTION content.no_mutation();
