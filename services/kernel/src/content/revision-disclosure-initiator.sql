SELECT d.route, d.disclosure_id, d.operation_id, d.thread_id, d.post_id, d.revision_id,
       encode(d.body_sha256, 'hex') AS sha256, d.licence, d.catalogue_id, d.catalogue_route,
       d.source_post_transaction_id, d.source_thread_transaction_id,
       d.source_post_security_revision::text, d.source_thread_security_revision::text,
       d.issuer_account_id, d.issued_transaction_id, d.issued_at::text, d.audience_kind,
       d.policy_version, d.actor_client_id, d.actor_scopes, d.actor_requested_by,
       d.actor_authn_epoch::text, d.original_minimum_authn_epoch, d.original_operator_account_id,
       d.original_delegation_transaction_id, d.original_delegation_issued_valid, d.source_digest,
       d.creation_idempotency_key, d.creation_request_digest, d.revoked_at::text,
       d.revocation_transaction_id, d.revoker_account_id
FROM content.revision_disclosure d
JOIN editorial.write_basis w
  ON w.partition_no = :partition_no::integer AND w.transaction_id = d.issued_transaction_id
 AND w.principal_kind = 'account' AND w.principal_id = d.issuer_account_id
 AND w.client_id = d.actor_client_id AND w.requested_by IS NOT DISTINCT FROM d.actor_requested_by
WHERE d.route = :route::integer AND d.operation_id = :operation_id::uuid
  AND d.disclosure_id = :disclosure_id::uuid
LIMIT 1;
