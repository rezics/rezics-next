-- migrate:up
CREATE TABLE library.type_preparation_header (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  account_id uuid NOT NULL,
  preparation_id uuid NOT NULL,
  binding_digest text NOT NULL CHECK (binding_digest ~ '^[0-9a-f]{64}$'),
  binding jsonb NOT NULL CHECK (jsonb_typeof(binding) = 'object'),
  origin jsonb NOT NULL CHECK (jsonb_typeof(origin) = 'object'),
  principal_namespace jsonb NOT NULL CHECK (jsonb_typeof(principal_namespace) = 'object'),
  reservation_id uuid,
  input_byte_length bigint NOT NULL CHECK (input_byte_length >= 0),
  input_digest bytea NOT NULL CHECK (octet_length(input_digest) = 32),
  creation_transaction_id uuid NOT NULL,
  creation_receipt jsonb NOT NULL CHECK (jsonb_typeof(creation_receipt) = 'object'),
  creation_commitment text NOT NULL CHECK (creation_commitment ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (route, account_id, preparation_id),
  UNIQUE (route, account_id, binding_digest, preparation_id),
  CHECK (route = get_byte(uuid_send(account_id), 10) * 256 + get_byte(uuid_send(account_id), 11)),
  CHECK (route = get_byte(uuid_send(preparation_id), 10) * 256 + get_byte(uuid_send(preparation_id), 11))
);
CREATE FUNCTION library.guard_type_preparation_header() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Type preparation headers are immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER type_preparation_header_immutable BEFORE UPDATE ON library.type_preparation_header
FOR EACH ROW EXECUTE FUNCTION library.guard_type_preparation_header();
CREATE TABLE library.type_preparation_progress (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  account_id uuid NOT NULL,
  preparation_id uuid NOT NULL,
  chunk bigint NOT NULL DEFAULT 0 CHECK (chunk >= 0),
  byte_offset bigint NOT NULL DEFAULT 0 CHECK (byte_offset >= 0),
  node_id uuid,
  state text NOT NULL CHECK (state IN ('pending', 'ready', 'cancelled')),
  type_id uuid,
  enqueue_pending boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (route, account_id, preparation_id),
  CHECK (route = get_byte(uuid_send(account_id), 10) * 256 + get_byte(uuid_send(account_id), 11)),
  CHECK (route = get_byte(uuid_send(preparation_id), 10) * 256 + get_byte(uuid_send(preparation_id), 11)),
  CHECK (state <> 'ready' OR (type_id IS NOT NULL AND NOT enqueue_pending)),
  FOREIGN KEY (route, account_id, preparation_id)
    REFERENCES library.type_preparation_header (route, account_id, preparation_id),
  FOREIGN KEY (route, account_id, type_id)
    REFERENCES library.shelf_type_value (route, account_id, type_id)
);
CREATE INDEX type_preparation_pending ON library.type_preparation_progress (route, account_id, preparation_id)
  WHERE enqueue_pending AND state = 'pending';
CREATE TABLE library.type_preparation_slot (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  account_id uuid NOT NULL,
  binding_digest text NOT NULL CHECK (binding_digest ~ '^[0-9a-f]{64}$'),
  preparation_id uuid NOT NULL,
  PRIMARY KEY (route, account_id, binding_digest),
  CHECK (route = get_byte(uuid_send(account_id), 10) * 256 + get_byte(uuid_send(account_id), 11)),
  CHECK (route = get_byte(uuid_send(preparation_id), 10) * 256 + get_byte(uuid_send(preparation_id), 11)),
  FOREIGN KEY (route, account_id, binding_digest, preparation_id)
    REFERENCES library.type_preparation_header (route, account_id, binding_digest, preparation_id)
);
COMMENT ON TABLE library.type_preparation_header IS
  'Immutable provenance storage, not authority or proof of completed effects. The authorized native creator validates exact TypePreparationBinding/Origin and principal/basis namespace (no bearer or actor permission result), and commits this header with the core receipt response metadataCommitment in one owner command. Before continuation, independently verify the actual receipt digest, transaction and full allowlisted header commitment; copied or late receipt JSON is never authority. Source and subject may be remote.';
COMMENT ON COLUMN library.type_preparation_header.creation_commitment IS
  'Commits preparation, owner, full binding, origin, principal/input association and creator receipt locator, excluding this commitment field itself. Publication and key payload remain exact native evidence.';
COMMENT ON COLUMN library.type_preparation_header.reservation_id IS
  'No FK: the native reservation retains exact accepted text and matching immutable EXTERNAL bytes until atomic final dictionary publication/removal. Header and DBOS contain no input copy. Ready progress refers to the immutable published value; exact reservation/value text comparison is required, never only a hash.';
COMMENT ON COLUMN library.type_preparation_header.input_digest IS
  'Lookup acceleration only, never exact input equality evidence or authority; no new per-type cap.';
COMMENT ON TABLE library.type_preparation_progress IS
  'Mutable native checkpoint/final mapping, separate from immutable evidence. Runner verifies offset <= header length, reservation/source association, current owner epoch, command and readiness. Edges/reservation progress, checkpoint and successor outbox commit together; final key, ready progress and reservation removal commit atomically. No cross-table CHECK or callback confers authority.';
COMMENT ON TABLE library.type_preparation_slot IS
  'Active owner binding slot. Digest hits require exact full binding, principal and native input comparison; collisions never alias. Equal live work converges. Only an admitted producer under current account/gate locks may replace cancelled/missing generations with a fresh UUID; source/owner epoch changes binding. Old receipts cannot trap replacement; purged owners cannot recreate slots. PKs support bounded owner enumeration: retirement/purge removes slots, progress, then headers/reservations and retains a minimal terminal fence. No automatic TTL or cascade.';
-- migrate:down
-- Forward only: native provenance and resumable progress require explicit fenced retirement.
