WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :subject_id::uuid AS subject_id
)
SELECT subject.subject_id::text AS id,
       subject.type,
       latest.revision,
       subject.current_release AS release,
       COALESCE(labels.label_values, '{}'::jsonb) AS labels,
       redirect.target::text AS redirect
FROM input
JOIN semantic.subject AS subject
  ON subject.route = input.route AND subject.subject_id = input.subject_id
JOIN LATERAL (
  SELECT revision
  FROM semantic.revision
  WHERE route = input.route AND subject_id = input.subject_id
  ORDER BY revision DESC
  LIMIT 1
) AS latest ON true
LEFT JOIN LATERAL (
  SELECT jsonb_object_agg(language, body) AS label_values
  FROM (
    SELECT DISTINCT ON (language) language, body, log_seq
    FROM semantic.fact
    WHERE route = input.route AND subject_id = input.subject_id AND kind = 'label' AND operation = 'assert'
    ORDER BY language, log_seq DESC
  ) AS current_labels
) AS labels ON true
LEFT JOIN LATERAL (
  SELECT target
  FROM semantic.redirect
  WHERE route = input.route AND subject_id = input.subject_id
  ORDER BY sequence DESC
  LIMIT 1
) AS redirect ON true
WHERE subject.visibility = 'visible';
