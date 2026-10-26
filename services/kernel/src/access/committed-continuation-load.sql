SELECT continuation_id AS "continuationId", account_id AS "accountId", operation_key AS "operationKey",
       operation_digest AS "operationDigest", command_key_prefix AS "commandKeyPrefix",
       barrier_receipt_id AS "barrierReceiptId", barrier_transaction_id AS "barrierTransactionId",
       minimum_authn_epoch::text AS "minimumAuthnEpoch", prior_handle AS "priorHandle",
       prior_operator_account_id AS "priorOperatorAccountId", prior_reservation_id AS "priorReservationId",
       allowlist, digest, created_at AS "createdAt", committed_expires_at AS "committedExpiresAt",
       expires_at AS "expiresAt"
FROM access.committed_continuation
WHERE route = :route AND continuation_id = :continuation_id
FOR SHARE;
