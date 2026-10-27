WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id, :kind::text AS kind,
         :group_id::uuid AS group_id, :reservation_id::uuid AS reservation_id,
         :proof_transaction_id::uuid AS proof_transaction_id, :transaction_id::uuid AS transaction_id
), account_lock AS MATERIALIZED (
  -- Closing an organization releases only its proven terminal reservation,
  -- including when the member has independently been suspended or deleted.
  SELECT 1
  FROM access.account a
  JOIN input i ON a.route = i.route AND a.account_id = i.account_id
  FOR UPDATE OF a
), proof AS (
  INSERT INTO access.membership_inverse_terminal
    (route, account_id, kind, group_id, reservation_id, reservation_transaction_id, proof_transaction_id, transaction_id)
  SELECT i.route, i.account_id, i.kind, i.group_id, i.reservation_id, m.transaction_id, i.proof_transaction_id, i.transaction_id
  FROM access.membership_inverse m, input i
  WHERE m.route = i.route AND m.account_id = i.account_id AND m.kind = i.kind AND m.group_id = i.group_id
    AND m.reservation_id = i.reservation_id AND EXISTS (SELECT 1 FROM account_lock)
  ON CONFLICT (route, account_id, kind, group_id, reservation_id) DO NOTHING
  RETURNING reservation_id, reservation_transaction_id
), verified AS MATERIALIZED (
  SELECT * FROM proof
  UNION ALL
  SELECT t.reservation_id, t.reservation_transaction_id FROM access.membership_inverse_terminal t, input i
  WHERE t.route = i.route AND t.account_id = i.account_id AND t.kind = i.kind AND t.group_id = i.group_id
    AND t.reservation_id = i.reservation_id AND t.proof_transaction_id = i.proof_transaction_id
), removed AS (
  DELETE FROM access.membership_inverse m USING input i
  WHERE m.route = i.route AND m.account_id = i.account_id AND m.kind = i.kind AND m.group_id = i.group_id
    AND m.reservation_id = i.reservation_id AND EXISTS (SELECT 1 FROM verified)
    AND EXISTS (SELECT 1 FROM account_lock)
  RETURNING m.reservation_id
), released AS (
  DELETE FROM access.lifecycle_coordination c USING input i, verified v
  WHERE c.route = i.route AND c.account_id = i.account_id AND c.reservation_id = i.reservation_id
    AND c.related_account_id = i.group_id AND c.purpose = 'membership'
    AND c.transaction_id = v.reservation_transaction_id
    AND EXISTS (SELECT 1 FROM account_lock)
  RETURNING c.reservation_id
)
SELECT reservation_id AS "reservationId" FROM removed
UNION SELECT reservation_id AS "reservationId" FROM released;
