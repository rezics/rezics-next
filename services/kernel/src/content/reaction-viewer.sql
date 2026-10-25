-- One primary-key seek in the viewer's partition for every target on this page.
SELECT requested.target_id AS "targetId", slot.kind
FROM unnest(:target_ids::uuid[]) AS requested(target_id)
CROSS JOIN LATERAL (
  SELECT stored.kind
  FROM content.reaction AS stored
  WHERE stored.route = :route::integer
    AND stored.actor_account_id = :actor_id::uuid
    AND stored.target_id = requested.target_id
  LIMIT 1
) AS slot;
