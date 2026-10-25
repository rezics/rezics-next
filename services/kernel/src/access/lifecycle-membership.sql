WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :organization_id::uuid AS organization_id, :member_id::uuid AS member_id
), slot AS (
  INSERT INTO access.lifecycle_membership_slot
    (route, organization_id, member_account_id, reservation_id, terminal, transaction_id)
  SELECT i.route, i.organization_id, i.member_id, :reservation_id, :removed, :transaction_id FROM input i
  ON CONFLICT (route, organization_id, member_account_id, reservation_id) DO UPDATE
  SET terminal = EXCLUDED.terminal, transaction_id = EXCLUDED.transaction_id
  WHERE NOT access.lifecycle_membership_slot.terminal
  RETURNING organization_id
), removed AS (
  DELETE FROM access.organization_member
  USING input i
  WHERE access.organization_member.route = i.route AND access.organization_member.organization_id = i.organization_id AND member_account_id = i.member_id
    AND EXISTS (SELECT 1 FROM slot)
  RETURNING access.organization_member.organization_id
)
SELECT organization_id FROM slot;
