-- migrate:up
-- The sole operation header; target membership stays in the installed bulk_target table.
CREATE TABLE library.bulk_operation (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  operation_id uuid NOT NULL,
  account_id uuid NOT NULL,
  request jsonb NOT NULL CHECK (jsonb_typeof(request) = 'object' AND octet_length(request::text) <= 262144),
  initiator jsonb NOT NULL CHECK (jsonb_typeof(initiator) = 'object' AND octet_length(initiator::text) <= 262144),
  creation_receipt jsonb NOT NULL CHECK (jsonb_typeof(creation_receipt) = 'object'),
  source_digest text NOT NULL CHECK (source_digest ~ '^[0-9a-f]{64}$'),
  target_count integer NOT NULL CHECK (target_count BETWEEN 0 AND 1000),
  phase text NOT NULL CHECK (phase IN ('preview', 'applying', 'completed')),
  admitted_at timestamptz NOT NULL,
  confirmed_at timestamptz,
  expires_at timestamptz NOT NULL,
  results_expire_at timestamptz NOT NULL,
  PRIMARY KEY (route, operation_id),
  CHECK (route = get_byte(uuid_send(operation_id), 10) * 256 + get_byte(uuid_send(operation_id), 11)),
  CHECK (route = get_byte(uuid_send(account_id), 10) * 256 + get_byte(uuid_send(account_id), 11)),
  CHECK (admitted_at < expires_at AND expires_at < results_expire_at)
);
CREATE INDEX bulk_operation_owner ON library.bulk_operation (route, account_id, operation_id);
CREATE INDEX bulk_operation_expiry ON library.bulk_operation (route, results_expire_at, operation_id);
CREATE INDEX bulk_operation_due ON library.bulk_operation (route, phase, expires_at, operation_id);
-- migrate:down
-- Forward only: operation identity and retained outcomes must survive rollback.
