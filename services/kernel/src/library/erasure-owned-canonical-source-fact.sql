WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id, :parent_id::uuid AS parent_id
), keys AS MATERIALIZED (
  SELECT child.generation, child.basis_digest, child.canonical_subject_id, child.stored_subject_id, child.driver, child.fact_id FROM library.canonical_source_fact AS child, input
  WHERE child.route=input.route AND child.collection_id=input.parent_id
    AND EXISTS (SELECT 1 FROM library.collection AS parent
                WHERE parent.route=input.route AND parent.curator_account_id=input.account_id AND parent.collection_id=input.parent_id)
  ORDER BY child.generation, child.basis_digest, child.canonical_subject_id, child.stored_subject_id, child.driver, child.fact_id LIMIT 100
)
DELETE FROM library.canonical_source_fact AS victim USING keys, input
WHERE victim.route=input.route AND victim.collection_id=input.parent_id AND victim.generation=keys.generation AND victim.basis_digest=keys.basis_digest AND victim.canonical_subject_id=keys.canonical_subject_id AND victim.stored_subject_id=keys.stored_subject_id AND victim.driver=keys.driver AND victim.fact_id=keys.fact_id
RETURNING true AS removed;
