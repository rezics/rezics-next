WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :realm_id::uuid AS realm_id, :realm_epoch::bigint AS realm_epoch,
         :source_route::integer AS source_route, :intent::text AS intent, :generation::bigint AS generation,
         :outcome::nullable(text) AS outcome, :transaction_id::nullable(uuid) AS transaction_id
), changed AS (
INSERT INTO community.realm_discovery_fence
(route, realm_id, realm_epoch, source_route, intent, generation, fence_generation, outcome, outcome_transaction_id)
SELECT i.route, r.realm_id, i.realm_epoch, i.source_route,
       i.intent, i.generation, r.discovery_generation + 1, i.outcome, i.transaction_id
FROM community.realm r CROSS JOIN input i WHERE r.route = i.route AND r.realm_id = i.realm_id
ON CONFLICT (route, realm_id, realm_epoch, source_route, intent, generation) DO UPDATE
SET outcome = COALESCE(community.realm_discovery_fence.outcome, EXCLUDED.outcome),
    outcome_transaction_id = COALESCE(community.realm_discovery_fence.outcome_transaction_id, EXCLUDED.outcome_transaction_id)
WHERE community.realm_discovery_fence.outcome IS NULL AND EXCLUDED.outcome IS NOT NULL
RETURNING fence_generation::text, outcome, outcome_transaction_id
)
SELECT fence_generation, outcome, outcome_transaction_id, true AS changed FROM changed
UNION ALL
SELECT f.fence_generation::text, f.outcome, f.outcome_transaction_id, false AS changed
FROM community.realm_discovery_fence f CROSS JOIN input i
WHERE f.route = i.route AND f.realm_id = i.realm_id AND f.realm_epoch = i.realm_epoch
  AND f.source_route = i.source_route AND f.intent = i.intent AND f.generation = i.generation
  AND NOT EXISTS (SELECT 1 FROM changed);
