SELECT account_id::text AS "accountId",
       verification_receipt_id::text AS "verificationReceiptId"
FROM access.agent_page
WHERE route = :route::integer AND subject_id = :subject_id::uuid;
