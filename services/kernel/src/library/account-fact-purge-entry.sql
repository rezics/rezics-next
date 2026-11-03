WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id,
         :after_id::nullable(uuid) AS after_id, :limit::integer AS page_limit
), source AS MATERIALIZED (
  SELECT subject_id FROM (
    (SELECT fact.subject_id
     FROM library.entry AS fact CROSS JOIN input
     WHERE fact.route = input.route AND fact.account_id = input.account_id
       AND (input.after_id IS NULL OR fact.subject_id > input.after_id)
     ORDER BY fact.subject_id LIMIT (SELECT page_limit FROM input))
    UNION
    (SELECT fact.subject_id
     FROM library.entry_personal_fact AS fact CROSS JOIN input
     WHERE fact.route = input.route AND fact.account_id = input.account_id
       AND (input.after_id IS NULL OR fact.subject_id > input.after_id)
     ORDER BY fact.subject_id LIMIT (SELECT page_limit FROM input))
  ) owners ORDER BY subject_id
  LIMIT (SELECT page_limit FROM input)
), removed_entry AS (
  DELETE FROM library.entry AS fact USING source, input
  WHERE fact.route = input.route AND fact.account_id = input.account_id
    AND fact.subject_id = source.subject_id
  RETURNING fact.subject_id
), removed_personal AS (
  DELETE FROM library.entry_personal_fact AS fact USING source, input
  WHERE fact.route = input.route AND fact.account_id = input.account_id
    AND fact.subject_id = source.subject_id
  RETURNING fact.subject_id
)
SELECT source.subject_id AS id,
  (EXISTS(SELECT 1 FROM removed_entry WHERE subject_id=source.subject_id) OR
   EXISTS(SELECT 1 FROM removed_personal WHERE subject_id=source.subject_id)) AS removed
FROM source
ORDER BY source.subject_id;
