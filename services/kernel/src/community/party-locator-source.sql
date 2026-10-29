-- Each branch uses a complete source key; no cross-partition join.
SELECT b.account_id::text AS account_id, 'ban_target' AS kind, lower(b.valid)::text AS due_at,
       b.route AS owner_route, b.realm_id::text AS owner_id, b.account_id::text AS key
FROM community.realm_ban b
WHERE :kind::text = 'ban' AND b.route = :route::integer AND b.realm_id = :id::uuid
  AND b.account_id = :target::nullable(uuid) AND b.valid @> :at::nullable(timestamptz)
UNION ALL
SELECT b.actor::text, 'ban_actor', (lower(b.valid) + interval '183 days')::text,
       b.route, b.realm_id::text, b.account_id::text
FROM community.realm_ban b
WHERE :kind::text = 'ban' AND b.route = :route::integer AND b.realm_id = :id::uuid
  AND b.account_id = :target::nullable(uuid) AND b.valid @> :at::nullable(timestamptz) AND b.actor IS NOT NULL
UNION ALL
SELECT DISTINCT p.account_id::text, 'membership_operation', o.requested_at::text,
       o.route, o.operation_id::text, o.operation_id::text
FROM community.realm_membership_operation o
CROSS JOIN LATERAL unnest(ARRAY[o.member_account_id, o.initiator_account_id, o.original_operator_account_id,
  split_part(o.actor_requested_by, ':', 4)::uuid, split_part(o.actor_requested_by, ':', 5)::uuid]) p(account_id)
WHERE :kind::text = 'membership_operation' AND o.route = :route::integer AND o.operation_id = :id::uuid
  AND p.account_id IS NOT NULL
UNION ALL
SELECT p.actor::text, 'verdict', p.created_at::text, p.route, p.publication_id::text, p.publication_id::text
FROM community.publication p
WHERE :kind::text = 'verdict' AND p.route = :route::integer AND p.publication_id = :id::uuid AND p.actor IS NOT NULL;
