DELETE FROM access.agent_page
WHERE route = :route::integer AND subject_id = :subject_id::uuid
  AND account_id = :account_id::uuid AND verification_receipt_id = :verification_receipt_id::uuid;
