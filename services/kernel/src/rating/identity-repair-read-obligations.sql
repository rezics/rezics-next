SELECT obligation_id AS "obligationId",
       work_id AS "workId",
       generation,
       page_id AS "pageId",
       page_digest AS "pageDigest",
       mapping_digest AS "mappingDigest",
       mappings,
       originals,
       through_question_id AS "throughQuestionId",
       through_target_id AS "throughTargetId",
       state,
       later_change AS "laterChange",
       later_vote AS "laterVote",
       receipt_transaction_id AS "receiptTransactionId",
       drain_receipt_id AS "drainReceiptId"
FROM semantic.identity_rating_repair_obligation
WHERE partition_no = $1::integer AND voter_id = $2::uuid
ORDER BY generation, obligation_id;
