SELECT s.subject_id::text AS id,
       s.visibility,
       s.security_revision::text AS security_revision,
       redirect.target::text AS redirect,
       COALESCE(labels.body, '{}'::jsonb) AS labels
FROM unnest(:routes::integer[], :subject_ids::uuid[]) AS input(route, id)
JOIN LATERAL (
  SELECT subject_id, visibility, security_revision FROM semantic.subject
  WHERE route = input.route AND subject_id = input.id
  LIMIT 1
) AS s ON true
LEFT JOIN LATERAL (
  SELECT target FROM semantic.redirect
  WHERE route = input.route AND subject_id = input.id
  ORDER BY sequence DESC
  LIMIT 1
) AS redirect ON true
LEFT JOIN LATERAL (
  SELECT COALESCE(jsonb_object_agg(language, body), '{}'::jsonb) AS body
  FROM (
    SELECT DISTINCT ON (language) language, body
    FROM (
      SELECT language, body, log_seq FROM semantic.fact
      WHERE route = input.route AND subject_id = input.id
        AND kind = 'label' AND operation = 'assert'
      OFFSET 0
    ) scanned
    ORDER BY language, log_seq DESC
  ) label_rows
) AS labels ON true;
