WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route
)
SELECT p.source, latest.revision AS retracted,
  CASE WHEN latest.revision IS NULL THEN NULL ELSE
    jsonb_build_object('source', latest.source, 'references', latest."references") END AS retraction
FROM semantic.revision p
CROSS JOIN input
LEFT JOIN LATERAL (
  SELECT t.revision, r.source, t."references" FROM semantic.retraction t JOIN semantic.revision r
    ON r.route = input.route AND r.subject_id = t.subject_id AND r.revision = t.revision
  WHERE t.route = input.route AND t.subject_id = p.subject_id AND t.candidate_id = :candidate_id::uuid
  ORDER BY t.revision DESC LIMIT 1
) latest ON true
WHERE p.route = input.route AND p.subject_id = :subject_id::uuid AND p.revision = :revision::integer;
