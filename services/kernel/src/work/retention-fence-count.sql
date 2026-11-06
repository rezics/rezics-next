/* work:workflow-retention-fences */
WITH input AS NOT MATERIALIZED (
  SELECT :ids::text[] AS ids
)
SELECT count(*)::bigint AS n
FROM dbos.workflow_writer_fences, input
WHERE workflow_uuid = ANY(input.ids);
