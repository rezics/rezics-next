WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :organization_id::uuid AS organization_id, :owner_id::uuid AS owner_id
)
SELECT s.reservation_id
FROM access.lifecycle_membership_slot s, input i
WHERE s.route = i.route AND s.organization_id = i.organization_id AND s.member_account_id = i.owner_id
  AND s.reservation_id = :reservation_id AND NOT s.terminal
  AND EXISTS (
    SELECT 1 FROM access.organization_member m
    WHERE m.route = i.route AND m.organization_id = i.organization_id AND m.member_account_id = i.owner_id
      AND m.role = 'owner' AND m.valid @> :at::timestamptz
  );
