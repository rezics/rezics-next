-- Home state is private to a verified person principal. All reads and writes
-- resolve the controlled person Agent again inside the Access transaction.
CREATE TABLE access.home_state (
  principal_id uuid PRIMARY KEY REFERENCES access.principal(id) ON DELETE CASCADE,
  revision uuid NOT NULL,
  preferences jsonb NOT NULL DEFAULT '{"tab":"following","sort":"best","density":"card","contentLanguages":[],"recommendations":true}'::jsonb
);
CREATE TABLE access.home_watermark (
  principal_id uuid NOT NULL REFERENCES access.principal(id) ON DELETE CASCADE,
  scope text NOT NULL CHECK (scope IN ('following', 'all') OR scope ~ '^realm:https://rezics.com/id/[0-9a-f-]{36}$'),
  data_epoch text NOT NULL,
  sequence numeric NOT NULL CHECK (sequence >= 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (principal_id, scope)
);
CREATE TABLE access.home_exclusion (
  principal_id uuid NOT NULL REFERENCES access.principal(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('activity', 'realm', 'tag', 'kind', 'person', 'work', 'continue')),
  target text NOT NULL,
  strength text NOT NULL CHECK (strength IN ('hide', 'fewer', 'mute', 'not-interested')),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (principal_id, kind, target)
);
CREATE INDEX home_exclusion_inventory ON access.home_exclusion (principal_id, strength, kind);
CREATE TABLE access.home_command_receipt (
  principal_id uuid NOT NULL REFERENCES access.principal(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  result jsonb NOT NULL,
  PRIMARY KEY (principal_id, idempotency_key)
);
CREATE TRIGGER home_command_receipt_immutable BEFORE UPDATE ON access.home_command_receipt
  FOR EACH ROW EXECUTE FUNCTION access.home_receipt_immutable();
