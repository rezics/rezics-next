SELECT o.thread_id, o.author_account_id, o.initiator_account_id, o.actor_client_id,
       o.actor_requested_by, o.actor_authn_epoch, o.actor_scopes, o.native_workflow_id,
       o.source_epoch, o.source_partition, o.source_position::text, o.source_event_index
FROM content.operation o
JOIN core.receipt r ON r.partition_no = :partition_no::integer AND r.principal_kind = 'account'
  AND r.principal_id = o.initiator_account_id AND r.command_kind = o.creation_command_kind
  AND r.idempotency_key = o.creation_idempotency_key AND r.transaction_id = o.recorded_transaction_id
  AND encode(r.request_digest, 'hex') = o.creation_request_digest
  AND r.response->>'operationId' = o.operation_id::text
  AND r.response->>'durableInitiator' ~ '^[0-9a-f]{64}$'
WHERE o.route = :route::integer AND o.operation_id = :operation_id::uuid;
