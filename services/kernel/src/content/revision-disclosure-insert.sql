INSERT INTO content.revision_disclosure (
  route, disclosure_id, operation_id, thread_id, post_id, revision_id, body_sha256, licence,
  catalogue_id, catalogue_route, source_post_transaction_id, source_thread_transaction_id,
  source_post_security_revision, source_thread_security_revision, issuer_account_id,
  issued_transaction_id, issued_at, audience_kind, policy_version, actor_client_id, actor_scopes,
  actor_requested_by, actor_authn_epoch, original_minimum_authn_epoch, original_operator_account_id,
  original_delegation_transaction_id, original_delegation_issued_valid, source_digest,
  creation_idempotency_key, creation_request_digest
) VALUES (
  :route::integer, :disclosure_id::uuid, :operation_id::uuid, :thread_id::uuid, :post_id::uuid,
  :revision_id::uuid, decode(:sha256::text, 'hex'), :licence::text, :catalogue_id::uuid,
  :catalogue_route::integer, :source_post_transaction_id::uuid, :source_thread_transaction_id::uuid,
  :source_post_security_revision::bigint, :source_thread_security_revision::bigint,
  :issuer_account_id::uuid, :issued_transaction_id::uuid, :issued_at::timestamptz,
  :audience_kind::text, :policy_version::text, :actor_client_id::text, :actor_scopes::text[],
  :actor_requested_by::nullable(text), :actor_authn_epoch::bigint,
  :original_minimum_authn_epoch::text, :original_operator_account_id::nullable(uuid),
  :original_delegation_transaction_id::nullable(uuid),
  :original_delegation_issued_valid::nullable(text), :source_digest::text,
  :creation_idempotency_key::text, :creation_request_digest::text
)
RETURNING disclosure_id;
