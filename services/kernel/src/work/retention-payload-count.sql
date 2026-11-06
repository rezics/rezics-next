/* work:workflow-retention-payload */
WITH input AS NOT MATERIALIZED (
  SELECT :ids::text[] AS ids
)
SELECT
  (SELECT count(*)::bigint FROM dbos.workflow_status WHERE workflow_uuid = ANY(ids)) AS workflow_status,
  (SELECT count(*)::bigint FROM dbos.workflow_input WHERE workflow_uuid = ANY(ids)) AS workflow_input,
  (SELECT count(*)::bigint FROM dbos.workflow_output WHERE workflow_uuid = ANY(ids)) AS workflow_output,
  (SELECT count(*)::bigint FROM dbos.operation_outputs WHERE workflow_uuid = ANY(ids)) AS operation_outputs,
  (SELECT count(*)::bigint FROM dbos.workflow_events WHERE workflow_uuid = ANY(ids)) AS workflow_events,
  (SELECT count(*)::bigint FROM dbos.workflow_events_history WHERE workflow_uuid = ANY(ids))
    AS workflow_events_history,
  (SELECT count(*)::bigint FROM dbos.notifications WHERE destination_uuid = ANY(ids)) AS notifications,
  (SELECT count(*)::bigint FROM dbos.streams WHERE workflow_uuid = ANY(ids)) AS streams
FROM input;
