/* work:workflow-retention-payload */
SELECT
  (SELECT count(*)::bigint FROM dbos.workflow_status WHERE workflow_uuid = ANY(:ids::text[])) AS workflow_status,
  (SELECT count(*)::bigint FROM dbos.workflow_input WHERE workflow_uuid = ANY(:ids::text[])) AS workflow_input,
  (SELECT count(*)::bigint FROM dbos.workflow_output WHERE workflow_uuid = ANY(:ids::text[])) AS workflow_output,
  (SELECT count(*)::bigint FROM dbos.operation_outputs WHERE workflow_uuid = ANY(:ids::text[])) AS operation_outputs,
  (SELECT count(*)::bigint FROM dbos.workflow_events WHERE workflow_uuid = ANY(:ids::text[])) AS workflow_events,
  (SELECT count(*)::bigint FROM dbos.workflow_events_history WHERE workflow_uuid = ANY(:ids::text[]))
    AS workflow_events_history,
  (SELECT count(*)::bigint FROM dbos.notifications WHERE destination_uuid = ANY(:ids::text[])) AS notifications,
  (SELECT count(*)::bigint FROM dbos.streams WHERE workflow_uuid = ANY(:ids::text[])) AS streams;
