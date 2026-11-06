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
  (SELECT count(*)::bigint FROM dbos.streams WHERE workflow_uuid = ANY(ids)) AS streams,
  (
    SELECT coalesce(sum(octet_length(to_jsonb(workflow_status)::text)), 0)::bigint
      FROM dbos.workflow_status WHERE workflow_uuid = ANY(ids)
  ) AS workflow_status_bytes,
  (
    SELECT coalesce(sum(octet_length(coalesce(inputs::text, ''))), 0)::bigint
      FROM dbos.workflow_input WHERE workflow_uuid = ANY(ids)
  ) AS workflow_input_bytes,
  (
    SELECT coalesce(sum(octet_length(coalesce(output::text, ''))
      + octet_length(coalesce(error::text, ''))), 0)::bigint
      FROM dbos.workflow_output WHERE workflow_uuid = ANY(ids)
  ) AS workflow_output_bytes,
  (
    SELECT coalesce(sum(octet_length(coalesce(output::text, ''))
      + octet_length(coalesce(error::text, ''))), 0)::bigint
      FROM dbos.operation_outputs WHERE workflow_uuid = ANY(ids)
  ) AS operation_outputs_bytes,
  (
    SELECT coalesce(sum(octet_length(coalesce(value::text, ''))), 0)::bigint
      FROM dbos.workflow_events WHERE workflow_uuid = ANY(ids)
  ) AS workflow_events_bytes,
  (
    SELECT coalesce(sum(octet_length(coalesce(value::text, ''))), 0)::bigint
      FROM dbos.workflow_events_history WHERE workflow_uuid = ANY(ids)
  ) AS workflow_events_history_bytes,
  (
    SELECT coalesce(sum(octet_length(coalesce(message::text, ''))), 0)::bigint
      FROM dbos.notifications WHERE destination_uuid = ANY(ids)
  ) AS notifications_bytes,
  (
    SELECT coalesce(sum(octet_length(coalesce(value::text, ''))), 0)::bigint
      FROM dbos.streams WHERE workflow_uuid = ANY(ids)
  ) AS streams_bytes
FROM input;
