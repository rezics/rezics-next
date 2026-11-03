WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id,
         :after_id::nullable(uuid) AS after_id, :limit::integer AS page_limit
), source AS MATERIALIZED (
  SELECT subject_id
  FROM (
    SELECT fact.subject_id
    FROM library.entry AS fact CROSS JOIN input
    WHERE fact.route = input.route AND fact.account_id = input.account_id
      AND (input.after_id IS NULL OR fact.subject_id > input.after_id)
    UNION
    SELECT history.subject_id
    FROM library.entry_state_change AS history CROSS JOIN input
    WHERE history.route = input.route AND history.account_id = input.account_id
      AND (input.after_id IS NULL OR history.subject_id > input.after_id)
  ) AS subjects
  ORDER BY subject_id
  LIMIT (SELECT page_limit FROM input)
), removed AS (
  DELETE FROM library.entry AS fact USING source, input
  WHERE fact.route = input.route AND fact.account_id = input.account_id
    AND fact.subject_id = source.subject_id
  RETURNING fact.subject_id
), removed_history AS (
  DELETE FROM library.entry_state_change AS history USING source, input
  WHERE history.route = input.route AND history.account_id = input.account_id
    AND history.subject_id = source.subject_id
  RETURNING history.subject_id
), history_subjects AS (
  SELECT DISTINCT subject_id FROM removed_history
)
SELECT source.subject_id AS id, (removed.subject_id IS NOT NULL OR history_subjects.subject_id IS NOT NULL) AS removed
FROM source
LEFT JOIN removed USING (subject_id)
LEFT JOIN history_subjects USING (subject_id)
ORDER BY source.subject_id;
