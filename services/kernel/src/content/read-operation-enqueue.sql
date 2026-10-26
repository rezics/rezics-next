SELECT o.thread_id, o.author_account_id, o.initiator_account_id, o.actor_client_id,
       o.actor_requested_by, o.actor_authn_epoch, o.actor_scopes, o.native_workflow_id,
       o.source_epoch, o.source_partition, o.source_position::text, o.source_event_index,
       o.operation_id, o.recorded_transaction_id, o.creation_command_kind,
       o.creation_idempotency_key, o.creation_request_digest
FROM content.operation o
WHERE o.route = :route::integer AND o.operation_id = :operation_id::uuid;
