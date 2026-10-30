WITH input AS NOT MATERIALIZED (SELECT :generation::bigint AS expected_generation)
SELECT route, intent, generation::text, target_kind, effect, target_id, native_version::text,
       source_version::text, thread_id, board_id, realm_id, space_id, realm_epoch::text,
       phase, fence_generation::text, preparation_transaction_id, outcome_transaction_id, projected
FROM content.realm_discovery_operation CROSS JOIN input
WHERE route = :route::integer AND intent = :intent::text
  AND (input.expected_generation = 0 OR generation = input.expected_generation)
ORDER BY content.realm_discovery_operation.generation DESC LIMIT 1 FOR UPDATE;
