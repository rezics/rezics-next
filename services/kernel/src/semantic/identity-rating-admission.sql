WITH bound AS MATERIALIZED (SELECT :subject_id::uuid AS subject_id),
input AS MATERIALIZED (
  SELECT subject_id,
         get_byte(uuid_send(subject_id), 10) * 256
           + get_byte(uuid_send(subject_id), 11) AS route
  FROM bound
)
SELECT subject.subject_id::text AS "subjectId",
       subject.visibility = 'visible' AS "activeTerminal",
       redirect.target::text AS redirect
FROM input
LEFT JOIN semantic.subject AS subject
  ON subject.route = input.route AND subject.subject_id = input.subject_id
LEFT JOIN LATERAL (
  SELECT redirect_row.target
  FROM semantic.redirect AS redirect_row
  WHERE redirect_row.route = input.route AND redirect_row.subject_id = input.subject_id
  ORDER BY redirect_row.sequence DESC
  LIMIT 1
) AS redirect ON true;
