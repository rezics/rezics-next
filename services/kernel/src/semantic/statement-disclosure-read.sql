WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :candidate_id::uuid AS candidate_id
)
SELECT d.subject_id::text, d.account_id::text, d.target_id::text, d.disclosed, c.property, c.slot_id::text,
       c.statement, c.release, c.revision, c.rank, c.relation, latest.revision AS latest_revision
FROM input JOIN semantic.statement_disclosure d ON d.route = input.route AND d.candidate_id = input.candidate_id
JOIN semantic.candidate c ON c.route = input.route AND c.subject_id = d.subject_id AND c.candidate_id = input.candidate_id
JOIN LATERAL (
  SELECT revision FROM semantic.revision r
  WHERE r.route = input.route AND r.subject_id = d.subject_id ORDER BY revision DESC LIMIT 1
) latest ON true;
