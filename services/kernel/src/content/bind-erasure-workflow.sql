-- The caller owns the independently anchored native projection transaction.
-- One full route-leading PK probe; no event/history scan or native job state.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :operation_id::uuid AS operation_id,
         :thread_id::uuid AS thread_id, :author_account_id::uuid AS author_account_id,
         :native_workflow_id::text AS native_workflow_id, :source_epoch::integer AS source_epoch,
         :source_partition::integer AS source_partition, :source_position::bigint AS source_position,
         :source_event_index::integer AS source_event_index
)
UPDATE content.operation AS stored
SET native_workflow_id = input.native_workflow_id,
    source_epoch = input.source_epoch,
    source_partition = input.source_partition,
    source_position = input.source_position,
    source_event_index = input.source_event_index
FROM input
WHERE stored.route = input.route AND stored.operation_id = input.operation_id
  AND stored.thread_id = input.thread_id AND stored.author_account_id = input.author_account_id
  AND (stored.native_workflow_id IS NULL OR
    ROW(stored.native_workflow_id, stored.source_epoch, stored.source_partition,
        stored.source_position, stored.source_event_index) =
    ROW(input.native_workflow_id, input.source_epoch, input.source_partition,
        input.source_position, input.source_event_index))
RETURNING stored.native_workflow_id;
