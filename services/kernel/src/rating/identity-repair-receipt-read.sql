SELECT page_id AS "pageId", work_id AS "workId", generation::text, digest,
       transaction_id AS "transactionId", checkpoint, terminal, mode, obligation_id AS "obligationId", mapping_digest AS "mappingDigest"
FROM rating.identity_repair_receipt
WHERE route = $1::integer AND voter_id = $2::uuid AND page_id = $3::uuid;
