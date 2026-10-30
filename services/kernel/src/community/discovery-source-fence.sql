WITH input AS NOT MATERIALIZED (SELECT :route::integer AS route), changed AS (
INSERT INTO community.realm_discovery_fence
(route, realm_id, realm_epoch, source_route, intent, generation, fence_generation, outcome, outcome_transaction_id)
SELECT i.route, r.realm_id, :realm_epoch::bigint, :source_route::integer,
       :intent::text, :generation::bigint, r.discovery_generation + 1,
       :outcome::nullable(text), :transaction_id::nullable(uuid)
FROM community.realm r CROSS JOIN input i WHERE r.route = i.route AND r.realm_id = :realm_id::uuid
ON CONFLICT (route, realm_id, realm_epoch, source_route, intent, generation) DO UPDATE
SET outcome = COALESCE(community.realm_discovery_fence.outcome, EXCLUDED.outcome),
    outcome_transaction_id = COALESCE(community.realm_discovery_fence.outcome_transaction_id, EXCLUDED.outcome_transaction_id)
WHERE community.realm_discovery_fence.outcome IS NULL AND EXCLUDED.outcome IS NOT NULL
RETURNING fence_generation::text, outcome, outcome_transaction_id
)
SELECT fence_generation, outcome, outcome_transaction_id, true AS changed FROM changed
UNION ALL
SELECT fence_generation::text, outcome, outcome_transaction_id, false AS changed
FROM community.realm_discovery_fence
WHERE route = :route::integer AND realm_id = :realm_id::uuid AND realm_epoch = :realm_epoch::bigint
  AND source_route = :source_route::integer AND intent = :intent::text AND generation = :generation::bigint
  AND NOT EXISTS (SELECT 1 FROM changed);
