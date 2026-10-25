SELECT initiator_account_id, thread_id, author_account_id, native_workflow_id
FROM content.operation
WHERE route = :route::integer AND operation_id = :operation_id::uuid;
