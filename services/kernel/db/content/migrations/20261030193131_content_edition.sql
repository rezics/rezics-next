-- migrate:up
-- Pointer-only fixed editions; native revision erasure remains the sole byte cleanup.
CREATE TABLE content.edition (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  edition_id uuid NOT NULL,
  creator_account_id uuid NOT NULL,
  target_subject_id uuid NOT NULL,
  thread_id uuid NOT NULL,
  post_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  body_sha256 bytea NOT NULL CHECK (octet_length(body_sha256) = 32),
  licence text NOT NULL CHECK (char_length(licence) BETWEEN 1 AND 128),
  state text NOT NULL CHECK (state IN ('draft', 'published', 'unpublished')),
  security_revision bigint NOT NULL CHECK (security_revision > 0),
  recorded_transaction_id uuid NOT NULL,
  created_at timestamptz NOT NULL CHECK (isfinite(created_at)),
  PRIMARY KEY (route, edition_id),
  CHECK (route = get_byte(uuid_send(edition_id), 10) * 256 + get_byte(uuid_send(edition_id), 11)),
  CHECK (route = get_byte(uuid_send(thread_id), 10) * 256 + get_byte(uuid_send(thread_id), 11)),
  CHECK (route = get_byte(uuid_send(post_id), 10) * 256 + get_byte(uuid_send(post_id), 11)),
  CHECK (route = get_byte(uuid_send(revision_id), 10) * 256 + get_byte(uuid_send(revision_id), 11))
);

-- The actual publish operation is immutable, separate from the draft's creation.
CREATE TABLE content.edition_publication (
  route integer NOT NULL,
  operation_id uuid NOT NULL,
  edition_id uuid NOT NULL,
  recorded_transaction_id uuid NOT NULL,
  initiator_account_id uuid NOT NULL,
  actor_client_id text NOT NULL,
  actor_scopes text[] NOT NULL CHECK (cardinality(actor_scopes) <= 512),
  actor_requested_by text,
  actor_authn_epoch bigint NOT NULL CHECK (actor_authn_epoch > 0),
  original_minimum_authn_epoch text NOT NULL,
  original_operator_account_id uuid,
  original_delegation_transaction_id uuid,
  original_delegation_issued_valid text,
  source_digest text NOT NULL CHECK (source_digest ~ '^[0-9a-f]{64}$'),
  creation_idempotency_key text NOT NULL,
  creation_request_digest text NOT NULL CHECK (creation_request_digest ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (route, operation_id),
  UNIQUE (route, edition_id),
  FOREIGN KEY (route, edition_id) REFERENCES content.edition(route, edition_id),
  CHECK (route = get_byte(uuid_send(operation_id), 10) * 256 + get_byte(uuid_send(operation_id), 11)),
  CHECK ((actor_requested_by IS NULL AND original_delegation_transaction_id IS NULL
          AND original_delegation_issued_valid IS NULL) OR
         (actor_requested_by IS NOT NULL AND original_delegation_transaction_id IS NOT NULL
          AND original_delegation_issued_valid IS NOT NULL))
);

CREATE FUNCTION content.guard_edition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Edition identity must survive unpublication' USING ERRCODE = '23514';
  END IF;
  IF ROW(NEW.route, NEW.edition_id, NEW.creator_account_id, NEW.thread_id, NEW.post_id, NEW.revision_id,
         NEW.body_sha256, NEW.licence, NEW.target_subject_id, NEW.recorded_transaction_id, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.route, OLD.edition_id, OLD.creator_account_id, OLD.thread_id, OLD.post_id, OLD.revision_id,
         OLD.body_sha256, OLD.licence, OLD.target_subject_id, OLD.recorded_transaction_id, OLD.created_at)
     OR NOT ((OLD.state = 'draft' AND NEW.state = 'published')
          OR (OLD.state = 'published' AND NEW.state = 'unpublished'))
     OR NEW.security_revision <> OLD.security_revision + 1 THEN
    RAISE EXCEPTION 'Edition binding is immutable and unpublication is terminal' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER edition_identity BEFORE UPDATE OR DELETE ON content.edition
  FOR EACH ROW EXECUTE FUNCTION content.guard_edition();

CREATE FUNCTION content.guard_edition_publication() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Edition publication provenance is immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER edition_publication_identity BEFORE UPDATE OR DELETE ON content.edition_publication
  FOR EACH ROW EXECUTE FUNCTION content.guard_edition_publication();

-- migrate:down
DROP TABLE content.edition_publication;
DROP TABLE content.edition;
DROP FUNCTION content.guard_edition_publication();
DROP FUNCTION content.guard_edition();
