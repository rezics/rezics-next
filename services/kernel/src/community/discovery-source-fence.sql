WITH input AS NOT MATERIALIZED (SELECT :route::integer AS route)
INSERT INTO community.realm_discovery_fence
(route, realm_id, realm_epoch, source_route, intent, generation, fence_generation, outcome, outcome_transaction_id)
SELECT i.route, r.realm_id, :realm_epoch::bigint, :source_route::integer,
       :intent::text, :generation::bigint, r.discovery_generation + 1,
       :outcome::nullable(text), :transaction_id::nullable(uuid)
FROM community.realm r CROSS JOIN input i WHERE r.route = i.route AND r.realm_id = :realm_id::uuid
ON CONFLICT (route, realm_id, realm_epoch, source_route, intent, generation) DO UPDATE
SET outcome = COALESCE(community.realm_discovery_fence.outcome, EXCLUDED.outcome),
    outcome_transaction_id = COALESCE(community.realm_discovery_fence.outcome_transaction_id, EXCLUDED.outcome_transaction_id)
RETURNING fence_generation::text, outcome, outcome_transaction_id;
