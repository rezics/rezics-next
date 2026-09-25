CREATE TABLE pkg.go_proxy_capture (
  id uuid PRIMARY KEY,
  principal_id uuid NOT NULL,
  idempotency_key text NOT NULL
    CHECK (idempotency_key ~ '^[A-Za-z0-9:_./-]{1,128}$'),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  capture_digest text NOT NULL CHECK (capture_digest ~ '^[0-9a-f]{64}$'),
  module_path text NOT NULL,
  module_version text NOT NULL,
  list_bytes bytea NOT NULL CHECK (octet_length(list_bytes) <= 131072),
  info_bytes bytea NOT NULL CHECK (octet_length(info_bytes) <= 4096),
  mod_bytes bytea NOT NULL CHECK (octet_length(mod_bytes) <= 131072),
  fetched_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (principal_id, idempotency_key)
);
CREATE INDEX go_proxy_capture_principal_idx ON pkg.go_proxy_capture (principal_id, id);
CREATE TRIGGER pkg_go_proxy_capture_immutable BEFORE UPDATE OR DELETE ON pkg.go_proxy_capture
  FOR EACH ROW EXECUTE FUNCTION pkg.no_mutation();
