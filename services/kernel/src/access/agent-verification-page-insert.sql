INSERT INTO access.agent_page AS page
  (route, subject_id, account_id, verification_receipt_id)
VALUES
  (:route::integer, :subject_id::uuid, :account_id::uuid, :verification_receipt_id::uuid)
ON CONFLICT (route, subject_id) DO UPDATE
SET account_id = page.account_id
WHERE page.account_id = EXCLUDED.account_id
  AND page.verification_receipt_id = EXCLUDED.verification_receipt_id
RETURNING page.account_id::text AS "accountId",
          page.verification_receipt_id::text AS "verificationReceiptId";
