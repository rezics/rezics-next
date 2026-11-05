WITH input AS NOT MATERIALIZED (SELECT :route::integer AS route, :account_id::uuid AS account_id, :barrier_id::text AS barrier_id, :after_id::text AS after_id, :sentinel::integer AS sentinel)
SELECT i.reservation_id::text AS "reservationId",i.realm_id::text AS "realmId",i.hold_transaction_id::text AS "holdTransactionId",
 EXISTS (SELECT 1 FROM access.membership_inverse m WHERE m.route=i.route AND m.account_id=i.account_id
  AND m.kind='realm' AND m.group_id=i.realm_id AND m.reservation_id=i.reservation_id
  AND m.transaction_id=i.hold_transaction_id) AS "provenanceValid", true AS admitted
FROM access.realm_membership_reconciliation_item i
WHERE i.route=(SELECT route FROM input) AND i.account_id=(SELECT account_id FROM input) AND i.barrier_id=(SELECT barrier_id FROM input)
 AND i.state IN ('pending','uncertain')
 AND (NULLIF((SELECT after_id FROM input),'')::uuid IS NULL OR i.reservation_id>NULLIF((SELECT after_id FROM input),'')::uuid)
ORDER BY i.reservation_id LIMIT (SELECT sentinel FROM input);
