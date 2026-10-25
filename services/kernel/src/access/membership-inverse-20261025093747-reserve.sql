-- The exact account row is already locked by this native command transaction.
-- A fixed sentinel probe includes both membership kinds, never role rows.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id, :kind::text AS kind,
         :group_id::uuid AS group_id, :reservation_id::uuid AS reservation_id,
         :transaction_id::uuid AS transaction_id, NULLIF(:source_transaction_id::text, '')::uuid AS source_transaction_id
), existing AS MATERIALIZED (
  SELECT m.reservation_id, m.transaction_id FROM access.membership_inverse m, input i
  WHERE m.route = i.route AND m.account_id = i.account_id AND m.kind = i.kind AND m.group_id = i.group_id
), admission AS MATERIALIZED (
  SELECT 1 FROM access.membership_inverse m, input i
  WHERE m.route = i.route AND m.account_id = i.account_id
  LIMIT 1001
), added AS (
  INSERT INTO access.membership_inverse
    (route, account_id, kind, group_id, reservation_id, transaction_id, source_transaction_id)
  SELECT i.route, i.account_id, i.kind, i.group_id, i.reservation_id, i.transaction_id, i.source_transaction_id FROM input i
  WHERE NOT EXISTS (SELECT 1 FROM existing) AND (SELECT count(*) FROM admission) < 1000
  RETURNING reservation_id, transaction_id
), chosen AS MATERIALIZED (
  SELECT * FROM existing UNION ALL SELECT * FROM added
), held AS (
  INSERT INTO access.lifecycle_coordination
    (route, account_id, reservation_id, related_account_id, purpose, transaction_id)
  SELECT i.route, i.account_id, c.reservation_id, i.group_id, 'membership', c.transaction_id FROM chosen c, input i
  ON CONFLICT (route, account_id, reservation_id) DO NOTHING
)
SELECT reservation_id AS "reservationId", (SELECT count(*)::integer FROM admission) AS admitted FROM chosen;
