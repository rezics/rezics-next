WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route,
         :subject_id::uuid AS subject_id,
         :partition_no::integer AS partition_no
)
SELECT subject.visibility, subject.security_revision::text AS "securityRevision",
       redirect.target::text AS redirect,
       p.partition_no AS "partitionNo", p.epoch, p.position::text AS position,
       latest.revision
FROM semantic.subject AS subject
CROSS JOIN input
CROSS JOIN core.partition AS p
LEFT JOIN LATERAL (
  SELECT redirect_row.target
  FROM semantic.redirect AS redirect_row
  WHERE redirect_row.route = subject.route AND redirect_row.subject_id = subject.subject_id
  ORDER BY redirect_row.sequence DESC
  LIMIT 1
) AS redirect ON true
LEFT JOIN LATERAL (
  SELECT revision_row.revision
  FROM semantic.revision AS revision_row
  WHERE revision_row.route = subject.route AND revision_row.subject_id = subject.subject_id
  ORDER BY revision_row.revision DESC
  LIMIT 1
) AS latest ON true
WHERE subject.route = input.route AND subject.subject_id = input.subject_id
  AND p.partition_no = input.partition_no;
