-- The exact account row is already locked by this native command transaction.
-- A fixed sentinel probe includes both membership kinds, never role rows.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id, :kind::text AS kind,
         :group_id::uuid AS group_id, :reservation_id::uuid AS reservation_id,
         :transaction_id::uuid AS transaction_id, NULLIF(:source_transaction_id::text, '')::uuid AS source_transaction_id,
         NULLIF(:previous_reservation_id::text, '')::uuid AS previous_reservation_id,
         NULLIF(:proof_transaction_id::text, '')::uuid AS proof_transaction_id
), existing AS MATERIALIZED (
  SELECT m.reservation_id, m.transaction_id FROM access.membership_inverse m, input i
  WHERE m.route = i.route AND m.account_id = i.account_id AND m.kind = i.kind AND m.group_id = i.group_id
), admission AS MATERIALIZED (
  SELECT 1 FROM access.membership_inverse m, input i
  WHERE m.route = i.route AND m.account_id = i.account_id
  LIMIT 1001
), retired AS (
  INSERT INTO access.membership_inverse_terminal
    (route, account_id, kind, group_id, reservation_id, reservation_transaction_id, proof_transaction_id, transaction_id)
  SELECT i.route, i.account_id, i.kind, i.group_id, e.reservation_id, e.transaction_id, i.proof_transaction_id, i.transaction_id
  FROM existing e, input i
  WHERE e.reservation_id = i.previous_reservation_id AND i.proof_transaction_id IS NOT NULL
  RETURNING reservation_id
), rotated AS (
  UPDATE access.membership_inverse m
  SET reservation_id = i.reservation_id, transaction_id = i.transaction_id, source_transaction_id = i.source_transaction_id
  FROM input i
  WHERE m.route = i.route AND m.account_id = i.account_id AND m.kind = i.kind AND m.group_id = i.group_id
    AND m.reservation_id = i.previous_reservation_id AND EXISTS (SELECT 1 FROM retired)
  RETURNING m.reservation_id, m.transaction_id
), added AS (
  -- Backfill may reuse a historical coordination hold. Keep its immutable
  -- reservation provenance so later terminal compensation can release it.
  INSERT INTO access.membership_inverse
    (route, account_id, kind, group_id, reservation_id, transaction_id, source_transaction_id)
  SELECT i.route, i.account_id, i.kind, i.group_id, i.reservation_id,
    COALESCE((SELECT c.transaction_id FROM access.lifecycle_coordination c
      WHERE c.route = i.route AND c.account_id = i.account_id AND c.reservation_id = i.reservation_id
        AND c.related_account_id = i.group_id AND c.purpose = 'membership'), i.transaction_id),
    i.source_transaction_id FROM input i
  WHERE NOT EXISTS (SELECT 1 FROM existing) AND (SELECT count(*) FROM admission) < 1000
  RETURNING reservation_id, transaction_id
), chosen AS MATERIALIZED (
  SELECT * FROM existing WHERE NOT EXISTS (SELECT 1 FROM retired)
  UNION ALL SELECT * FROM rotated
  UNION ALL SELECT * FROM added
), held AS (
  INSERT INTO access.lifecycle_coordination
    (route, account_id, reservation_id, related_account_id, purpose, transaction_id)
  SELECT i.route, i.account_id, c.reservation_id, i.group_id, 'membership', c.transaction_id FROM chosen c, input i
  WHERE i.kind <> 'realm' OR i.source_transaction_id IS NOT NULL
  ON CONFLICT (route, account_id, reservation_id) DO NOTHING
)
-- A duplicate key cannot bless a hold from another operation. The snapshot sees
-- pre-existing holds; a newly inserted hold is bound by held's SELECT above.
SELECT c.reservation_id AS "reservationId", (SELECT count(*)::integer FROM admission) AS admitted,
  NOT EXISTS (
    SELECT 1 FROM access.lifecycle_coordination h, input i
    WHERE h.route = i.route AND h.account_id = i.account_id AND h.reservation_id = c.reservation_id
      AND (h.related_account_id <> i.group_id OR h.purpose <> 'membership' OR h.transaction_id <> c.transaction_id)
  ) AS "provenanceValid"
FROM chosen c;
