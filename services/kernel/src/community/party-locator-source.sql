WITH input AS NOT MATERIALIZED (
  SELECT :kind::text AS kind, :route::integer AS route, :id::uuid AS id, :realm::uuid AS realm,
         :target::nullable(uuid) AS target, :at::nullable(timestamptz) AS at
)
-- Each branch uses a complete source key; no cross-partition join.
SELECT b.account_id::text AS account_id, 'ban_target' AS kind, lower(b.valid)::text AS due_at,
       b.route AS owner_route, b.realm_id::text AS owner_id, b.account_id::text AS key
FROM community.realm_ban b CROSS JOIN input i
WHERE i.kind = 'ban' AND b.route = i.route AND b.realm_id = i.id
  AND b.account_id = i.target AND b.valid @> i.at
UNION ALL
SELECT b.actor::text, 'ban_actor', (lower(b.valid) + interval '183 days')::text,
       b.route, b.realm_id::text, b.account_id::text
FROM community.realm_ban b CROSS JOIN input i
WHERE i.kind = 'ban' AND b.route = i.route AND b.realm_id = i.id
  AND b.account_id = i.target AND b.valid @> i.at AND b.actor IS NOT NULL
UNION ALL
SELECT DISTINCT p.account_id::text, 'membership_operation', o.requested_at::text,
       o.route, o.operation_id::text, o.operation_id::text
FROM community.realm_membership_operation o CROSS JOIN input i
CROSS JOIN LATERAL unnest(ARRAY[o.member_account_id, o.initiator_account_id, o.original_operator_account_id,
  split_part(o.actor_requested_by, ':', 4)::uuid]) p(account_id)
WHERE i.kind = 'membership_operation' AND o.route = i.route AND o.operation_id = i.id
  AND p.account_id IS NOT NULL
UNION ALL
SELECT p.actor::text, 'verdict', p.created_at::text, p.route, p.publication_id::text, p.publication_id::text
FROM community.publication p CROSS JOIN input i
WHERE i.kind = 'verdict' AND p.route = i.route AND p.publication_id = i.id AND p.actor IS NOT NULL
UNION ALL
SELECT q.account_id::text, 'claim_request', q.requested_at::text, q.route, q.realm_id::text, q.request_id::text
FROM community.realm_claim_request q CROSS JOIN input i
WHERE i.kind = 'claim_request' AND q.route = i.route AND q.realm_id = i.realm AND q.request_id = i.id
UNION ALL
SELECT h.removed_by::text, 'space_remover', h.removed_at::text, h.route, h.space_id::text, h.space_id::text
FROM community.space h CROSS JOIN input i
WHERE i.kind = 'space_remover' AND h.route = i.route AND h.space_id = i.id AND h.removed_by IS NOT NULL

UNION ALL
SELECT h.removed_by::text, 'realm_remover', h.removed_at::text, h.route, h.realm_id::text, h.realm_id::text
FROM community.realm h CROSS JOIN input i
WHERE i.kind = 'realm_remover' AND h.route = i.route AND h.realm_id = i.id AND h.removed_by IS NOT NULL;
