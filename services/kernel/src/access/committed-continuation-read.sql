SELECT continuation_id AS "continuationId", account_id AS "accountId", operation_key AS "operationKey",
       operation_digest AS "operationDigest", command_key_prefix AS "commandKeyPrefix",
       barrier_receipt_id AS "barrierReceiptId", barrier_transaction_id AS "barrierTransactionId",
       minimum_authn_epoch::text AS "minimumAuthnEpoch", prior_handle AS "priorHandle",
       prior_operator_account_id AS "priorOperatorAccountId", prior_reservation_id AS "priorReservationId",
       allowlist,
       (SELECT COALESCE(jsonb_agg(jsonb_build_object('step', e.step, 'target', e.target, 'key', e.key, 'digest', e.digest)
                                 ORDER BY e.step, e.target, e.key), '[]'::jsonb)
        FROM access.committed_continuation_entry e
        WHERE e.route = c.route AND e.continuation_id = c.continuation_id) AS "derivedAllowlist",
       digest, created_at AS "createdAt", committed_expires_at AS "committedExpiresAt",
       expires_at AS "expiresAt"
FROM access.committed_continuation c
WHERE route = :route AND operation_key = :operation_key;
