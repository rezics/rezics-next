-- migrate:up
-- Exact Content custody evidence, never a replacement for native source authority.
CREATE TABLE content.authored_field_purge (
  route integer NOT NULL,
  document_id uuid NOT NULL,
  subject_id uuid NOT NULL,
  candidate_id uuid NOT NULL,
  revision bigint NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  deletion_generation text NOT NULL CHECK (length(deletion_generation) > 0),
  source_version text NOT NULL CHECK (length(source_version) > 0),
  deletion_transaction_id text NOT NULL CHECK (length(deletion_transaction_id) > 0),
  deletion_committed_at timestamptz NOT NULL CHECK (isfinite(deletion_committed_at)),
  purge_after timestamptz NOT NULL CHECK (isfinite(purge_after)),
  PRIMARY KEY (route, document_id),
  FOREIGN KEY (route, document_id) REFERENCES content.authored_field(route, id),
  CHECK (purge_after = deletion_committed_at + interval '720 hours'),
  CHECK (route = get_byte(uuid_send(subject_id), 10) * 256 + get_byte(uuid_send(subject_id), 11)),
  CHECK (route = get_byte(uuid_send(candidate_id), 10) * 256 + get_byte(uuid_send(candidate_id), 11))
);

CREATE FUNCTION content.guard_authored_field_purge() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Authored field purge source binding is immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER authored_field_purge_immutable BEFORE UPDATE OR DELETE ON content.authored_field_purge
FOR EACH ROW EXECUTE FUNCTION content.guard_authored_field_purge();

-- migrate:down
-- Forward only: irreversible physical custody evidence must survive replay.
