WITH input AS NOT MATERIALIZED (
  SELECT :partition_no::integer AS partition_no
)
SELECT s.subject_id::text AS id, s.type,
       agent_subject.account_id::text AS agent_account_id,
       COALESCE(agent_subject.verified, false) AS agent_verified
FROM unnest(:routes::integer[], :subject_ids::uuid[]) AS requested(route, id)
JOIN input ON requested.route >= input.partition_no * 16
          AND requested.route < (input.partition_no + 1) * 16
JOIN semantic.subject AS s
  ON s.route = requested.route
 AND s.subject_id = requested.id
 AND s.route >= input.partition_no * 16
 AND s.route < (input.partition_no + 1) * 16
 AND s.visibility = 'visible'
-- The exact route equality carries the requested partition guard to the link.
-- A separate link partition range can scan unrelated links; a lateral boundary
-- instead pays every absent lookup again when the link table is small.
LEFT JOIN semantic.account_agent_subject AS agent_subject
  ON agent_subject.route = requested.route AND agent_subject.subject_id = requested.id
 AND requested.route >= input.partition_no * 16
 AND requested.route < (input.partition_no + 1) * 16;
