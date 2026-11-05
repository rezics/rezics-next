WITH input AS NOT MATERIALIZED (
  SELECT :partition_no::integer AS partition_no
),
page AS MATERIALIZED (
  SELECT s.route, s.subject_id
  FROM semantic.subject AS s
  CROSS JOIN input
  WHERE s.route >= input.partition_no * 16
    AND s.route < (input.partition_no + 1) * 16
    AND (s.route, s.subject_id) > (:after_route::integer, :after_id::uuid)
  ORDER BY s.route, s.subject_id
  LIMIT :limit::integer
)
SELECT page.route,
       page.subject_id::text AS id,
       COALESCE(labels.body, '{}'::jsonb) AS body
FROM page
LEFT JOIN LATERAL (
  SELECT COALESCE(jsonb_object_agg(language, body), '{}'::jsonb) AS body
  FROM (
    SELECT DISTINCT ON (language) language, body
    FROM (
      SELECT language, body, log_seq FROM semantic.current_term_fact
      CROSS JOIN input
      WHERE route = page.route AND subject_id = page.subject_id
        AND kind = 'label' AND operation = 'assert'
        AND route >= input.partition_no * 16
        AND route < (input.partition_no + 1) * 16
      OFFSET 0
    ) scanned
    ORDER BY language, log_seq DESC
  ) label_rows
) AS labels ON true
ORDER BY page.route, page.subject_id;
