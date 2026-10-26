WITH RECURSIVE input AS NOT MATERIALIZED (
  SELECT :route::integer AS route,
         :question_id::uuid AS question_id,
         :target_id::uuid AS target_id,
         :after_population_id::uuid AS after_population_id,
         :limit::integer AS page_limit
), raw_candidate_ids(population_id, ordinal) AS (
  SELECT (
    SELECT component.population_id
    FROM rating.aggregate_component AS component
    CROSS JOIN input
    WHERE component.route = input.route
      AND component.question_id = input.question_id
      AND component.target_id = input.target_id
      AND component.population_id > input.after_population_id
      AND component.count > 0
    ORDER BY component.population_id
    LIMIT 1
  ), 1
  UNION ALL
  SELECT (
    SELECT component.population_id
    FROM rating.aggregate_component AS component
    CROSS JOIN input
    WHERE component.route = input.route
      AND component.question_id = input.question_id
      AND component.target_id = input.target_id
      AND component.population_id > previous.population_id
      AND component.count > 0
    ORDER BY component.population_id
    LIMIT 1
  ), previous.ordinal + 1
  FROM raw_candidate_ids AS previous
  CROSS JOIN input
  WHERE previous.population_id IS NOT NULL
    AND previous.ordinal < input.page_limit + 1
), candidate_ids AS MATERIALIZED (
  SELECT population_id, ordinal
  FROM raw_candidate_ids
  WHERE population_id IS NOT NULL
), page AS (
  SELECT population_id, ordinal
  FROM candidate_ids
  WHERE ordinal <= (SELECT page_limit FROM input)
), page_counts AS (
  SELECT page.population_id, sum(component.count)::text AS count, page.ordinal
  FROM page
  CROSS JOIN input
  JOIN rating.aggregate_component AS component
    ON component.route = input.route
   AND component.question_id = input.question_id
   AND component.target_id = input.target_id
   AND component.population_id = page.population_id
  GROUP BY page.population_id, page.ordinal
), page_state AS (
  SELECT count(*) > input.page_limit AS has_more
  FROM candidate_ids CROSS JOIN input
  GROUP BY input.page_limit
)
SELECT page_counts.population_id::text AS population, page_counts.count, page_state.has_more AS "hasMore"
FROM page_counts CROSS JOIN page_state
ORDER BY page_counts.population_id;
