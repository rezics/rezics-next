SELECT i.reservation_id::text AS "reservationId",i.realm_id::text AS "realmId",i.hold_transaction_id::text AS "holdTransactionId",
 EXISTS (SELECT 1 FROM access.membership_inverse m WHERE m.route=i.route AND m.account_id=i.account_id
  AND m.kind='realm' AND m.group_id=i.realm_id AND m.reservation_id=i.reservation_id
  AND m.transaction_id=i.hold_transaction_id) AS "provenanceValid", true AS admitted
FROM access.realm_membership_reconciliation_item i
WHERE i.route=:route::integer AND i.account_id=:account_id::uuid AND i.barrier_id=:barrier_id::text
 AND i.state IN ('pending','uncertain')
 AND (NULLIF(:after_id::text,'')::uuid IS NULL OR i.reservation_id>NULLIF(:after_id::text,'')::uuid)
ORDER BY i.reservation_id LIMIT :sentinel::integer;
