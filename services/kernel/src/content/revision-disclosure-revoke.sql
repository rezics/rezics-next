UPDATE content.revision_disclosure
SET revoked_at = :revoked_at::timestamptz,
    revocation_transaction_id = :revocation_transaction_id::uuid,
    revoker_account_id = :revoker_account_id::uuid
WHERE route = :route::integer AND disclosure_id = :disclosure_id::uuid AND revoked_at IS NULL
RETURNING disclosure_id;
