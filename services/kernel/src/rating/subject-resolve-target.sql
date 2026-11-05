WITH input AS MATERIALIZED (
  SELECT :subject_id::uuid AS subject_id
),
routed_input AS MATERIALIZED (
  SELECT input.subject_id,
         get_byte(uuid_send(input.subject_id), 10) * 256
           + get_byte(uuid_send(input.subject_id), 11) AS route
  FROM input
),
direct_redirect AS MATERIALIZED (
  SELECT redirect.target
  FROM semantic.redirect AS redirect
  JOIN routed_input ON routed_input.route = redirect.route AND routed_input.subject_id = redirect.subject_id
  ORDER BY redirect.sequence DESC
  LIMIT 1
),
candidate AS (
  SELECT COALESCE(direct_redirect.target, routed_input.subject_id) AS target
  FROM routed_input
  LEFT JOIN direct_redirect ON true
)
SELECT candidate.target::text AS "subjectId",
       terminal.visibility = 'visible' AS "activeTerminal",
       EXISTS (
         SELECT 1
         FROM semantic.redirect AS target_redirect
         WHERE target_redirect.route = get_byte(uuid_send(candidate.target), 10) * 256
                                     + get_byte(uuid_send(candidate.target), 11)
           AND target_redirect.subject_id = candidate.target
       ) AS "targetRedirecting"
FROM candidate
LEFT JOIN semantic.subject AS terminal
  ON terminal.route = get_byte(uuid_send(candidate.target), 10) * 256
                   + get_byte(uuid_send(candidate.target), 11)
 AND terminal.subject_id = candidate.target;
