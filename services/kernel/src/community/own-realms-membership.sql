-- Materialize each full-key identity before its exact head join. Historical
-- intervals and revisions must not become residual scans behind LIMIT 1.
WITH member AS MATERIALIZED (
  SELECT realm_id, role, reservation_id, transaction_id, valid
  FROM community.realm_member
  WHERE route = :route::integer
    AND realm_id = :realm_id::uuid AND account_id = :account_id::uuid
    AND upper_inf(valid)
), head AS MATERIALIZED (
  SELECT realm_id, head_revision_id, lifecycle_version
  FROM community.realm
  WHERE route = :route::integer AND realm_id = :realm_id::uuid
    AND state = 'active' AND created_at <= :at::timestamptz
)
SELECT m.realm_id::text AS "realmId", r.title AS name,
       m.reservation_id::text AS "reservationId", m.transaction_id::text AS "transactionId",
       lower(m.valid)::text AS since, m.valid::text AS "interval",
       h.head_revision_id::text AS "headRevisionId", h.lifecycle_version::text AS "lifecycleVersion"
FROM member m
JOIN head h ON h.realm_id = m.realm_id
JOIN community.realm_revision r
  ON r.route = :route::integer AND r.realm_id = h.realm_id AND r.revision_id = h.head_revision_id
WHERE m.role = 'member' AND (m.valid @> :at::timestamptz) IS TRUE
  AND r.created_at <= :at::timestamptz;
