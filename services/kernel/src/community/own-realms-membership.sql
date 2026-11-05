-- Materialize each full-key identity before its exact head join. Historical
-- intervals and revisions must not become residual scans behind LIMIT 1.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :realm_id::uuid AS realm_id,
         :account_id::uuid AS account_id, :at::timestamptz AS at
), member AS MATERIALIZED (
  SELECT m.realm_id, m.role, m.reservation_id, m.transaction_id, m.valid
  FROM community.realm_member m CROSS JOIN input i
  WHERE m.route = i.route AND m.realm_id = i.realm_id AND m.account_id = i.account_id
    AND upper_inf(m.valid)
), head AS MATERIALIZED (
  SELECT h.realm_id, h.head_revision_id, h.lifecycle_version
  FROM community.realm h CROSS JOIN input i
  WHERE h.route = i.route AND h.realm_id = i.realm_id
    AND h.state = 'active' AND h.created_at <= i.at
)
SELECT m.realm_id::text AS "realmId", r.title AS name,
       m.reservation_id::text AS "reservationId", m.transaction_id::text AS "transactionId",
       lower(m.valid)::text AS since, m.valid::text AS "interval",
       h.head_revision_id::text AS "headRevisionId", h.lifecycle_version::text AS "lifecycleVersion"
FROM member m
JOIN head h ON h.realm_id = m.realm_id
CROSS JOIN input i
JOIN community.realm_revision r
  ON r.route = i.route AND r.realm_id = h.realm_id AND r.revision_id = h.head_revision_id
WHERE m.role = 'member' AND (m.valid @> i.at) IS TRUE
  AND r.created_at <= i.at
LIMIT 1;
