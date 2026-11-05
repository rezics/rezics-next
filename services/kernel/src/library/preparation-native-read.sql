SELECT route, account_id::text AS "accountId", preparation_id::text AS "preparationId",
       binding, origin, source_identity AS "sourceIdentity", origin_identity AS "originIdentity",
       principal_namespace AS "principalNamespace", reservation_id::text AS "reservationId",
       input_byte_length::text AS "inputByteLength", encode(input_digest, 'hex') AS "inputDigest",
       creation_transaction_id::text AS "creationTransactionId", creation_receipt AS "creationReceipt",
       creation_commitment AS "creationCommitment",
       to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt"
FROM library.type_preparation_header
WHERE route = :route AND account_id = :account_id AND preparation_id = :preparation_id;
