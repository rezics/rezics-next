UPDATE content.realm_discovery_operation
SET phase = :phase::text,
    fence_generation = COALESCE(:fence_generation::nullable(bigint), fence_generation),
    outcome_transaction_id = COALESCE(:transaction_id::nullable(uuid), outcome_transaction_id),
    projected = :projected::boolean
WHERE route = :route::integer AND intent = :intent::text AND generation = :generation::bigint
  AND phase = :expected::text
RETURNING generation::text;
