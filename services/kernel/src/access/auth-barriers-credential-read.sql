SELECT receipt_id AS "receiptId", account_id AS "accountId", opening_receipt_id AS "openingReceiptId",
 operation_key AS "operationKey", effect_reference AS "effectReference", effect_digest AS "effectDigest",
 purpose, previous_floor::text AS "previousFloor", minimum_authn_epoch::text AS "minimumAuthnEpoch", fenced
FROM access.credential_floor_receipt
WHERE route = :route AND account_id = :account_id AND opening_receipt_id = :opening_receipt_id;
