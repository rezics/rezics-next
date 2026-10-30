WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :collection_id::uuid AS collection_id
), keys AS MATERIALIZED (
  SELECT generation, basis_digest, canonical_subject_id, stored_subject_id, driver, fact_id
  FROM library.canonical_source_fact AS child CROSS JOIN input
  WHERE child.route = input.route AND child.collection_id = input.collection_id
  ORDER BY generation, basis_digest, canonical_subject_id, stored_subject_id, driver, fact_id LIMIT 64
)
DELETE FROM library.canonical_source_fact AS victim USING keys, input
WHERE victim.route = input.route AND victim.collection_id = input.collection_id
  AND (victim.generation, victim.basis_digest, victim.canonical_subject_id,
       victim.stored_subject_id, victim.driver, victim.fact_id) =
      (keys.generation, keys.basis_digest, keys.canonical_subject_id,
       keys.stored_subject_id, keys.driver, keys.fact_id)
RETURNING true AS removed;
