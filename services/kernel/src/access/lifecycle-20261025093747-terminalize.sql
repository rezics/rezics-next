-- Compensation can close an unpublished reservation, including failed creation.
-- A published membership must leave through the authorized organization command.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :organization_id::uuid AS organization_id,
         :member_id::uuid AS member_id
)
INSERT INTO access.lifecycle_membership_slot
  (route, organization_id, member_account_id, reservation_id, terminal, transaction_id)
SELECT i.route, i.organization_id, i.member_id, :reservation_id, true, :transaction_id FROM input i
WHERE NOT EXISTS (
  SELECT 1 FROM access.organization_member m
  WHERE m.route = i.route AND m.organization_id = i.organization_id AND m.member_account_id = i.member_id
)
ON CONFLICT (route, organization_id, member_account_id, reservation_id) DO NOTHING
RETURNING reservation_id AS "reservationId";
