WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :organization_id::uuid AS organization_id,
         :member_id::uuid AS member_id, :at::timestamptz AS at, :transaction_id::uuid AS transaction_id
), slot AS (
  INSERT INTO access.lifecycle_membership_slot
    (route, organization_id, member_account_id, reservation_id, terminal, transaction_id)
  SELECT i.route, i.organization_id, i.member_id, :reservation_id, :removed, i.transaction_id FROM input i
  ON CONFLICT (route, organization_id, member_account_id, reservation_id) DO UPDATE
  SET terminal = EXCLUDED.terminal, transaction_id = EXCLUDED.transaction_id
  WHERE NOT access.lifecycle_membership_slot.terminal
  RETURNING organization_id
)
SELECT s.organization_id,
       access.close_membership_authority(i.route, i.organization_id, i.member_id, i.at, i.transaction_id) AS changed
FROM slot s, input i;
