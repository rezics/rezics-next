-- Probe at most the admitted neighborhood plus an overflow sentinel. An
-- overflow refuses the page; it never certifies a truncated account.
WITH neighborhood AS MATERIALIZED (
 SELECT m.* FROM access.membership_inverse m
 WHERE m.route=:route::integer AND m.account_id=:account_id::uuid AND m.kind='realm'
 ORDER BY m.group_id LIMIT 1001
)
SELECT h.reservation_id::text AS "reservationId", h.related_account_id::text AS "realmId",
       h.transaction_id::text AS "holdTransactionId",
       (m.reservation_id=h.reservation_id AND m.transaction_id=h.transaction_id) AS "provenanceValid",
       (SELECT count(*)<=1000 FROM neighborhood) AS admitted
FROM access.lifecycle_coordination h
JOIN neighborhood m ON m.route=h.route AND m.account_id=h.account_id AND m.group_id=h.related_account_id
WHERE h.route=:route::integer AND h.account_id=:account_id::uuid AND h.purpose='membership'
 AND NOT EXISTS (SELECT 1 FROM access.realm_membership_transition t
  WHERE t.route=h.route AND t.account_id=h.account_id AND t.generation_id=h.reservation_id AND NOT t.legacy)
 AND (NULLIF(:after_id::text,'')::uuid IS NULL OR h.reservation_id>NULLIF(:after_id::text,'')::uuid)
ORDER BY h.reservation_id LIMIT :sentinel::integer;
