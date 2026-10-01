INSERT INTO content.receipt_action(action) VALUES ('identity.merge') ON CONFLICT DO NOTHING;

-- A merge visits the source across all readers, not one person's shelf.
CREATE INDEX library_status_merge_inventory ON reader.library_status(work, agent COLLATE "C");
CREATE TABLE reader.library_status_merge_receipt (
  command_key text PRIMARY KEY CHECK (command_key ~ '^merge:[0-9a-f]{64}$'),
  task_key text NOT NULL,
  agent text NOT NULL CHECK (agent ~ '^https://rezics.com/id/[0-9a-f-]{36}$'),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object' AND octet_length(result::text) <= 65536
    AND (result->>'outcome') IN ('moved','history','retained','ambiguous') AND (result->>'outcome') IS NOT NULL
    AND (result->>'commandKey') IS NOT DISTINCT FROM command_key
    AND (result->>'receipt') IS NOT DISTINCT FROM ('urn:rezics:library:' || command_key)),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER library_status_merge_receipt_immutable BEFORE UPDATE OR DELETE
  ON reader.library_status_merge_receipt FOR EACH ROW EXECUTE FUNCTION content.no_mutation();
