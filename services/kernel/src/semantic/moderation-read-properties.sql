WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :subject_id::uuid AS subject_id
), current_release AS MATERIALIZED (
  SELECT revision.release FROM semantic.revision revision CROSS JOIN input
  WHERE revision.route = input.route AND revision.subject_id = input.subject_id
  ORDER BY revision.revision DESC LIMIT 1
)
SELECT DISTINCT fact.property
FROM semantic.fact fact CROSS JOIN input CROSS JOIN current_release
LEFT JOIN semantic.definition_release definition
  ON definition.route = 0 AND definition.digest = COALESCE(fact.release, current_release.release)
WHERE fact.route = input.route AND fact.subject_id = input.subject_id
  AND fact.kind = 'statement' AND fact.property IS NOT NULL
  AND COALESCE(
    definition.body #>> ARRAY['properties', fact.property, 'relation', 'group'],
    ''
  ) NOT IN ('order', 'derivation', 'world', 'membership', 'association', 'credit', 'appearance');
