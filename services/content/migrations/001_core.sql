CREATE SCHEMA IF NOT EXISTS content;

CREATE TABLE content.owner_control (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  data_epoch uuid NOT NULL,
  sequence bigint NOT NULL DEFAULT 0 CHECK (sequence >= 0)
);
INSERT INTO content.owner_control (singleton, data_epoch) VALUES (true, gen_random_uuid())
ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE content.variant (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 300),
  resource_id text NOT NULL CHECK (length(resource_id) BETWEEN 1 AND 300),
  language_kind text NOT NULL CHECK (language_kind IN ('tag', 'missing', 'und', 'mul', 'zxx')),
  language_tag text,
  original_language_tag text,
  direction text NOT NULL CHECK (direction IN ('ltr', 'rtl', 'none')),
  draft_head uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((language_kind = 'tag' AND language_tag IS NOT NULL AND original_language_tag IS NOT NULL)
    OR (language_kind <> 'tag' AND language_tag IS NULL AND original_language_tag IS NULL))
);
CREATE INDEX variant_resource_idx ON content.variant (resource_id, id);

CREATE TABLE content.revision (
  id uuid PRIMARY KEY,
  variant_id text NOT NULL REFERENCES content.variant(id),
  predecessor uuid,
  operation_id text NOT NULL UNIQUE,
  format text NOT NULL CHECK (format = 'rezics-content-json-v1'),
  model text NOT NULL CHECK (length(model) BETWEEN 1 AND 200),
  source_revision text,
  provenance jsonb NOT NULL CHECK (jsonb_typeof(provenance) = 'object' AND octet_length(provenance::text) <= 16384),
  byte_digest text NOT NULL CHECK (byte_digest ~ '^[0-9a-f]{64}$'),
  byte_length integer NOT NULL CHECK (byte_length BETWEEN 1 AND 1048576),
  serialized_bytes bytea,
  body jsonb,
  availability text NOT NULL DEFAULT 'available' CHECK (availability IN ('available', 'erased', 'unavailable')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (variant_id, id),
  CHECK ((availability = 'available' AND serialized_bytes IS NOT NULL AND body IS NOT NULL
    AND octet_length(serialized_bytes) = byte_length)
    OR (availability <> 'available' AND serialized_bytes IS NULL AND body IS NULL)),
  FOREIGN KEY (variant_id, predecessor) REFERENCES content.revision(variant_id, id)
);
ALTER TABLE content.variant ADD CONSTRAINT variant_draft_head_fk
  FOREIGN KEY (id, draft_head) REFERENCES content.revision(variant_id, id);
CREATE INDEX revision_variant_created_idx ON content.revision (variant_id, created_at DESC, id);

CREATE TABLE content.receipt (
  operation_id text PRIMARY KEY CHECK (length(operation_id) BETWEEN 1 AND 200),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  action text NOT NULL CHECK (action IN ('draft.save', 'publication.prepare', 'publication.settle')),
  outcome text NOT NULL CHECK (outcome IN ('succeeded', 'stale_head', 'rejected')),
  variant_id text REFERENCES content.variant(id),
  revision_id uuid REFERENCES content.revision(id),
  reason text,
  data_epoch uuid NOT NULL,
  sequence bigint NOT NULL CHECK (sequence > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (data_epoch, sequence)
);

CREATE TABLE content.publication_preparation (
  operation_id text PRIMARY KEY CHECK (length(operation_id) BETWEEN 1 AND 200),
  revision_id uuid NOT NULL REFERENCES content.revision(id),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'rejected')),
  pin_active boolean NOT NULL DEFAULT true,
  graph_receipt text,
  graph_data_epoch text,
  graph_sequence text,
  terminal_proof_digest text,
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  CHECK ((status = 'pending' AND pin_active AND graph_receipt IS NULL AND settled_at IS NULL)
    OR (status = 'active' AND pin_active AND graph_receipt IS NOT NULL AND settled_at IS NOT NULL)
    OR (status = 'rejected' AND NOT pin_active AND graph_receipt IS NOT NULL AND settled_at IS NOT NULL))
);
CREATE INDEX publication_revision_pin_idx ON content.publication_preparation (revision_id)
  WHERE pin_active;

CREATE TABLE content.outbox (
  id uuid PRIMARY KEY,
  data_epoch uuid NOT NULL,
  sequence bigint NOT NULL CHECK (sequence > 0),
  operation_id text NOT NULL REFERENCES content.receipt(operation_id),
  event_type text NOT NULL,
  recipe text NOT NULL,
  revision_id uuid REFERENCES content.revision(id),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (data_epoch, sequence),
  FOREIGN KEY (data_epoch, sequence) REFERENCES content.receipt(data_epoch, sequence)
);
CREATE INDEX outbox_position_idx ON content.outbox (data_epoch, sequence, id);

CREATE FUNCTION content.no_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'immutable Content record' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER receipt_immutable BEFORE UPDATE OR DELETE ON content.receipt
  FOR EACH ROW EXECUTE FUNCTION content.no_mutation();
CREATE TRIGGER outbox_immutable BEFORE UPDATE OR DELETE ON content.outbox
  FOR EACH ROW EXECUTE FUNCTION content.no_mutation();

CREATE FUNCTION content.variant_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.id, OLD.resource_id, OLD.language_kind, OLD.language_tag, OLD.original_language_tag,
      OLD.direction, OLD.created_at)
     IS DISTINCT FROM
     (NEW.id, NEW.resource_id, NEW.language_kind, NEW.language_tag, NEW.original_language_tag,
      NEW.direction, NEW.created_at) THEN
    RAISE EXCEPTION 'immutable Content variant identity' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER variant_identity_immutable BEFORE UPDATE ON content.variant
  FOR EACH ROW EXECUTE FUNCTION content.variant_identity_guard();

CREATE FUNCTION content.revision_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.id, OLD.variant_id, OLD.predecessor, OLD.operation_id, OLD.format, OLD.model,
      OLD.source_revision, OLD.provenance,
      OLD.byte_digest, OLD.byte_length, OLD.created_at)
     IS DISTINCT FROM
     (NEW.id, NEW.variant_id, NEW.predecessor, NEW.operation_id, NEW.format, NEW.model,
      NEW.source_revision, NEW.provenance,
      NEW.byte_digest, NEW.byte_length, NEW.created_at) THEN
    RAISE EXCEPTION 'immutable Content revision anchor' USING ERRCODE = '23514';
  END IF;
  IF OLD.availability <> 'available' OR
     (NEW.availability = 'available' AND
      (OLD.serialized_bytes IS DISTINCT FROM NEW.serialized_bytes OR OLD.body IS DISTINCT FROM NEW.body)) THEN
    RAISE EXCEPTION 'immutable Content revision bytes' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER revision_immutable BEFORE UPDATE OR DELETE ON content.revision
  FOR EACH ROW EXECUTE FUNCTION content.revision_guard();

CREATE FUNCTION content.preparation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Content preparation cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'pending' OR NEW.status = 'pending' OR
     (OLD.operation_id, OLD.revision_id, OLD.request_digest, OLD.created_at)
       IS DISTINCT FROM
     (NEW.operation_id, NEW.revision_id, NEW.request_digest, NEW.created_at) THEN
    RAISE EXCEPTION 'invalid Content preparation transition' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER preparation_monotone BEFORE UPDATE OR DELETE ON content.publication_preparation
  FOR EACH ROW EXECUTE FUNCTION content.preparation_guard();
