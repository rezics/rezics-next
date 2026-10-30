INSERT INTO content.realm_discovery_operation
(route, intent, generation, target_kind, effect, target_id, native_version, source_version,
 thread_id, board_id, realm_id, space_id, realm_epoch, preparation_transaction_id)
VALUES (:route::integer, :intent::text, :generation::bigint, :kind::text, :effect::text, :id::uuid,
        :native_version::bigint, :source_version::bigint, :thread_id::nullable(uuid),
        :board_id::uuid, :realm_id::uuid, :space_id::uuid, :realm_epoch::bigint, :transaction_id::uuid)
RETURNING generation::text;
