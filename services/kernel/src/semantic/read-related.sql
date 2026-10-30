WITH input AS NOT MATERIALIZED (
  SELECT :partition_no::integer AS partition_no
)
SELECT s.subject_id::text AS id,
       s.visibility,
       s.security_revision::text AS security_revision,
       redirect.target::text AS redirect,
       COALESCE(labels.body, '{}'::jsonb) AS labels
FROM unnest(:routes::integer[], :subject_ids::uuid[]) AS requested(route, id)
JOIN LATERAL (
  SELECT subject_id, visibility, security_revision FROM semantic.subject
  CROSS JOIN input
  WHERE route = requested.route AND subject_id = requested.id
    AND route >= input.partition_no * 16
    AND route < (input.partition_no + 1) * 16
  LIMIT 1
) AS s ON true
LEFT JOIN LATERAL (
  SELECT target FROM semantic.redirect
  CROSS JOIN input
  WHERE route = requested.route AND subject_id = requested.id
    AND route >= input.partition_no * 16
    AND route < (input.partition_no + 1) * 16
  ORDER BY sequence DESC
  LIMIT 1
) AS redirect ON true
LEFT JOIN LATERAL (
  SELECT COALESCE(jsonb_object_agg(language, body), '{}'::jsonb) AS body
  FROM (
    SELECT DISTINCT ON (language) language, body
    FROM (
      SELECT language, body, log_seq FROM semantic.current_term_fact
      CROSS JOIN input
      WHERE route = requested.route AND subject_id = requested.id
        AND kind = 'label' AND operation = 'assert'
        AND route >= input.partition_no * 16
        AND route < (input.partition_no + 1) * 16
      OFFSET 0
    ) scanned
    ORDER BY language, log_seq DESC
  ) label_rows
) AS labels ON true;
