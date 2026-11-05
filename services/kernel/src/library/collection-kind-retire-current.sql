WITH selected AS MATERIALIZED (
  SELECT observation.* FROM library.collection_kind_observation AS observation
  LEFT JOIN library.collection AS parent
    ON parent.route=observation.route AND parent.collection_id=observation.collection_id
  WHERE observation.route=:route::integer AND observation.collection_id=:collection_id::uuid
    AND (parent.collection_id IS NULL OR parent.state<>'active' OR parent.presentation_kind IS NOT NULL
      OR parent.source_generation<>observation.source_generation)
  ORDER BY observation.audience COLLATE "C" LIMIT 1 FOR UPDATE OF observation
), retained AS (
  INSERT INTO library.collection_kind_retired(route,collection_id,account_id,audience,generation,capture)
  SELECT route,collection_id,account_id,audience,generation,capture FROM selected
  ON CONFLICT DO NOTHING
)
DELETE FROM library.collection_kind_observation AS victim USING selected
WHERE victim.route=selected.route AND victim.collection_id=selected.collection_id
  AND victim.audience=selected.audience AND victim.generation=selected.generation
RETURNING victim.generation::text;
