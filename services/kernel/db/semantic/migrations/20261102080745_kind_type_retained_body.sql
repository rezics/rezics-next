-- migrate:up
-- Immutable dependency bodies are not audience/admission/currentness evidence.
-- One record retains one raw original and terminal; duplicate canonical supports
-- retain distinct raw keys. No population vector or second frontier is stored.
CREATE TABLE semantic.kind_type_evidence_body (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  owner_account_id uuid NOT NULL,
  collection_id uuid NOT NULL,
  preparation_id uuid NOT NULL,
  evidence_id uuid NOT NULL,
  binding jsonb NOT NULL CHECK (jsonb_typeof(binding) = 'object' AND octet_length(binding::text) <= 16384),
  body jsonb NOT NULL CHECK (jsonb_typeof(body) = 'object' AND octet_length(body::text) <= 16384),
  progress jsonb NOT NULL CHECK (jsonb_typeof(progress) = 'object' AND octet_length(progress::text) <= 4096),
  producer_transaction text NOT NULL CHECK (producer_transaction ~ '^[0-9]{1,20}$'),
  PRIMARY KEY (route, owner_account_id, collection_id, preparation_id, evidence_id),
  CHECK (route = get_byte(uuid_send(collection_id), 10) * 256 + get_byte(uuid_send(collection_id), 11)),
  CHECK (route = get_byte(uuid_send(owner_account_id), 10) * 256 + get_byte(uuid_send(owner_account_id), 11))
);

CREATE FUNCTION semantic.immutable_kind_type_evidence_body() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Kind Type dependency bodies are immutable';
END;
$$;
CREATE TRIGGER immutable_kind_type_evidence_body
  BEFORE UPDATE ON semantic.kind_type_evidence_body
  FOR EACH ROW EXECUTE FUNCTION semantic.immutable_kind_type_evidence_body();

-- migrate:down
DROP TABLE semantic.kind_type_evidence_body;
DROP FUNCTION semantic.immutable_kind_type_evidence_body();
