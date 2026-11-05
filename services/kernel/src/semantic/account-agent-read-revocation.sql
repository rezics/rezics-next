SELECT revision, verification_receipt_id, revoked_survivor_id::text AS survivor
FROM semantic.revision
WHERE route = :route::integer AND subject_id = :subject_id::uuid
  AND kind = 'merge' AND revocation_receipt_id = :receipt_id::text
ORDER BY revision DESC
LIMIT 1;
