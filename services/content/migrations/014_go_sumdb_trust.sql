CREATE TABLE pkg.go_sumdb_head_history (
  id uuid PRIMARY KEY,
  previous_id uuid REFERENCES pkg.go_sumdb_head_history(id),
  tree_size bigint NOT NULL CHECK (tree_size > 0),
  root_hash text NOT NULL,
  signed_note bytea NOT NULL CHECK (octet_length(signed_note) <= 4096),
  consistency_tile_paths text[] NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER pkg_go_sumdb_head_history_immutable
  BEFORE UPDATE OR DELETE ON pkg.go_sumdb_head_history
  FOR EACH ROW EXECUTE FUNCTION pkg.no_mutation();

CREATE TABLE pkg.go_sumdb_head (
  server text PRIMARY KEY CHECK (server = 'sum.golang.org'),
  history_id uuid NOT NULL REFERENCES pkg.go_sumdb_head_history(id),
  tree_size bigint NOT NULL CHECK (tree_size > 0),
  root_hash text NOT NULL,
  signed_note bytea NOT NULL CHECK (octet_length(signed_note) <= 4096),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION pkg.guard_go_sumdb_head() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'trusted Go checksum head cannot be deleted';
  END IF;
  IF NEW.tree_size < OLD.tree_size OR
    (NEW.tree_size = OLD.tree_size AND NEW.root_hash <> OLD.root_hash) THEN
    RAISE EXCEPTION 'trusted Go checksum head cannot roll back or fork';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER pkg_go_sumdb_head_guard
  BEFORE UPDATE OR DELETE ON pkg.go_sumdb_head
  FOR EACH ROW EXECUTE FUNCTION pkg.guard_go_sumdb_head();

CREATE TABLE pkg.go_sumdb_verification (
  id uuid PRIMARY KEY,
  principal_id uuid NOT NULL,
  idempotency_key text NOT NULL
    CHECK (idempotency_key ~ '^[A-Za-z0-9:_./-]{1,128}$'),
  capture_id uuid NOT NULL REFERENCES pkg.go_proxy_capture(id),
  capture_mod_sha256 text NOT NULL CHECK (capture_mod_sha256 ~ '^[0-9a-f]{64}$'),
  evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'object'),
  trusted_head_id uuid NOT NULL REFERENCES pkg.go_sumdb_head_history(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (principal_id, idempotency_key)
);
CREATE INDEX go_sumdb_verification_principal_idx
  ON pkg.go_sumdb_verification (principal_id, id);
CREATE TRIGGER pkg_go_sumdb_verification_immutable
  BEFORE UPDATE OR DELETE ON pkg.go_sumdb_verification
  FOR EACH ROW EXECUTE FUNCTION pkg.no_mutation();
