-- migrate:up
-- Source-home Book-scoped exact revision consent. Additive and unmounted: no
-- public route, grant floor or ordinary Post/Thread visibility change. Public
-- targets keep Access public eligibility and need no row. Catalogue identity is
-- stored, never joined across homes. Native erasure pages the source locators.
CREATE TABLE content.revision_disclosure (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  disclosure_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  thread_id uuid NOT NULL,
  post_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  body_sha256 bytea NOT NULL CHECK (octet_length(body_sha256) = 32),
  licence text NOT NULL CHECK (char_length(licence) BETWEEN 1 AND 128),
  catalogue_id uuid NOT NULL,
  catalogue_route integer NOT NULL CHECK (catalogue_route BETWEEN 0 AND 65535),
  source_post_transaction_id uuid NOT NULL,
  source_thread_transaction_id uuid NOT NULL,
  source_post_security_revision bigint NOT NULL CHECK (source_post_security_revision > 0),
  source_thread_security_revision bigint NOT NULL CHECK (source_thread_security_revision > 0),
  issuer_account_id uuid NOT NULL,
  issued_transaction_id uuid NOT NULL,
  issued_at timestamptz NOT NULL CHECK (isfinite(issued_at)),
  audience_kind text NOT NULL CHECK (audience_kind = 'book-publication'),
  policy_version text NOT NULL CHECK (policy_version ~ '^[1-9][0-9]{0,8}$'),
  actor_client_id text NOT NULL CHECK (actor_client_id ~ '^[!-~]{1,1024}$'),
  actor_scopes text[] NOT NULL CHECK (content.operation_scopes_valid(actor_scopes)),
  actor_requested_by text,
  actor_authn_epoch bigint NOT NULL CHECK (actor_authn_epoch > 0),
  original_minimum_authn_epoch text NOT NULL CHECK (original_minimum_authn_epoch ~ '^[1-9][0-9]{0,18}$'),
  original_operator_account_id uuid,
  original_delegation_transaction_id uuid,
  original_delegation_issued_valid text,
  source_digest text NOT NULL CHECK (source_digest ~ '^[0-9a-f]{64}$'),
  creation_idempotency_key text NOT NULL CHECK (creation_idempotency_key ~ '^[!-~]{1,255}$'),
  creation_request_digest text NOT NULL CHECK (creation_request_digest ~ '^[0-9a-f]{64}$'),
  revoked_at timestamptz CHECK (revoked_at IS NULL OR (isfinite(revoked_at) AND revoked_at >= issued_at)),
  revocation_transaction_id uuid,
  revoker_account_id uuid,
  PRIMARY KEY (route, disclosure_id),
  UNIQUE (route, operation_id),
  CHECK (route = get_byte(uuid_send(disclosure_id), 10) * 256 + get_byte(uuid_send(disclosure_id), 11)),
  CHECK (route = get_byte(uuid_send(operation_id), 10) * 256 + get_byte(uuid_send(operation_id), 11)),
  CHECK (route = get_byte(uuid_send(thread_id), 10) * 256 + get_byte(uuid_send(thread_id), 11)),
  CHECK (route = get_byte(uuid_send(post_id), 10) * 256 + get_byte(uuid_send(post_id), 11)),
  CHECK (route = get_byte(uuid_send(revision_id), 10) * 256 + get_byte(uuid_send(revision_id), 11)),
  CHECK (route = get_byte(uuid_send(issuer_account_id), 10) * 256 + get_byte(uuid_send(issuer_account_id), 11)),
  CHECK (route = get_byte(uuid_send(issued_transaction_id), 10) * 256 + get_byte(uuid_send(issued_transaction_id), 11)),
  CHECK (route = get_byte(uuid_send(source_post_transaction_id), 10) * 256 + get_byte(uuid_send(source_post_transaction_id), 11)),
  CHECK (route = get_byte(uuid_send(source_thread_transaction_id), 10) * 256 + get_byte(uuid_send(source_thread_transaction_id), 11)),
  CHECK (catalogue_route = get_byte(uuid_send(catalogue_id), 10) * 256 + get_byte(uuid_send(catalogue_id), 11)),
  CHECK ((actor_requested_by IS NULL AND original_delegation_transaction_id IS NULL
          AND original_delegation_issued_valid IS NULL) OR
         (actor_requested_by IS NOT NULL AND original_delegation_transaction_id IS NOT NULL
          AND original_delegation_issued_valid IS NOT NULL
          AND char_length(actor_requested_by) <= 128
          AND actor_requested_by ~ '^urn:rezics:request:[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')),
  CHECK (original_operator_account_id IS NULL OR content.operation_routable_uuid(original_operator_account_id)),
  CHECK (original_delegation_transaction_id IS NULL OR content.operation_routable_uuid(original_delegation_transaction_id)),
  CHECK (original_delegation_issued_valid IS NULL OR char_length(original_delegation_issued_valid) BETWEEN 1 AND 256),
  CHECK ((revoked_at IS NULL) = (revocation_transaction_id IS NULL)
     AND (revoked_at IS NULL) = (revoker_account_id IS NULL)),
  CHECK (revocation_transaction_id IS NULL OR (
    route = get_byte(uuid_send(revocation_transaction_id), 10) * 256
      + get_byte(uuid_send(revocation_transaction_id), 11)
    AND route = get_byte(uuid_send(revoker_account_id), 10) * 256
      + get_byte(uuid_send(revoker_account_id), 11)))
);

COMMENT ON TABLE content.revision_disclosure IS
  'Exact Book-scoped source consent for one private opening revision. Consent does not grant read.';

-- Full-key issued lookup: one live consent per catalogue and exact source.
CREATE UNIQUE INDEX revision_disclosure_issued_key
  ON content.revision_disclosure (
    route, catalogue_id, thread_id, post_id, revision_id, body_sha256
  )
  WHERE revoked_at IS NULL;

-- Source erasure and exact revision locators. Pages never scan Book history.
CREATE INDEX revision_disclosure_post_idx
  ON content.revision_disclosure (route, post_id, disclosure_id);
CREATE INDEX revision_disclosure_revision_idx
  ON content.revision_disclosure (route, revision_id, disclosure_id);
CREATE INDEX revision_disclosure_thread_idx
  ON content.revision_disclosure (route, thread_id, disclosure_id);
CREATE INDEX revision_disclosure_catalogue_idx
  ON content.revision_disclosure (catalogue_route, catalogue_id, route, disclosure_id);

CREATE FUNCTION content.guard_revision_disclosure() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Revision disclosure identity is retained for source erasure' USING ERRCODE = '23514';
  END IF;
  IF ROW(NEW.route, NEW.disclosure_id, NEW.operation_id, NEW.thread_id, NEW.post_id, NEW.revision_id,
         NEW.body_sha256, NEW.licence, NEW.catalogue_id, NEW.catalogue_route,
         NEW.source_post_transaction_id, NEW.source_thread_transaction_id,
         NEW.source_post_security_revision, NEW.source_thread_security_revision,
         NEW.issuer_account_id, NEW.issued_transaction_id, NEW.issued_at,
         NEW.audience_kind, NEW.policy_version, NEW.actor_client_id, NEW.actor_scopes,
         NEW.actor_requested_by, NEW.actor_authn_epoch, NEW.original_minimum_authn_epoch,
         NEW.original_operator_account_id, NEW.original_delegation_transaction_id,
         NEW.original_delegation_issued_valid, NEW.source_digest,
         NEW.creation_idempotency_key, NEW.creation_request_digest)
     IS DISTINCT FROM
     ROW(OLD.route, OLD.disclosure_id, OLD.operation_id, OLD.thread_id, OLD.post_id, OLD.revision_id,
         OLD.body_sha256, OLD.licence, OLD.catalogue_id, OLD.catalogue_route,
         OLD.source_post_transaction_id, OLD.source_thread_transaction_id,
         OLD.source_post_security_revision, OLD.source_thread_security_revision,
         OLD.issuer_account_id, OLD.issued_transaction_id, OLD.issued_at,
         OLD.audience_kind, OLD.policy_version, OLD.actor_client_id, OLD.actor_scopes,
         OLD.actor_requested_by, OLD.actor_authn_epoch, OLD.original_minimum_authn_epoch,
         OLD.original_operator_account_id, OLD.original_delegation_transaction_id,
         OLD.original_delegation_issued_valid, OLD.source_digest,
         OLD.creation_idempotency_key, OLD.creation_request_digest)
     OR OLD.revoked_at IS NOT NULL
     OR NEW.revoked_at IS NULL THEN
    RAISE EXCEPTION 'Revision disclosure binding is immutable and revocation is terminal' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER revision_disclosure_identity BEFORE UPDATE OR DELETE ON content.revision_disclosure
  FOR EACH ROW EXECUTE FUNCTION content.guard_revision_disclosure();

-- migrate:down
DROP TRIGGER revision_disclosure_identity ON content.revision_disclosure;
DROP FUNCTION content.guard_revision_disclosure();
DROP TABLE content.revision_disclosure;
