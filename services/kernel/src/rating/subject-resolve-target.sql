WITH RECURSIVE subject_chain(subject_id, depth) AS (
  SELECT :subject_id::uuid, 0
  UNION ALL
  SELECT next_redirect.target, subject_chain.depth + 1
  FROM subject_chain
  CROSS JOIN LATERAL (
    SELECT redirect.target
    FROM semantic.redirect AS redirect
    WHERE redirect.route = get_byte(uuid_send(subject_chain.subject_id), 10) * 256
                           + get_byte(uuid_send(subject_chain.subject_id), 11)
      AND redirect.subject_id = subject_chain.subject_id
    ORDER BY redirect.sequence DESC
    LIMIT 1
  ) AS next_redirect
)
SELECT subject_id::text AS "subjectId"
FROM subject_chain
ORDER BY depth DESC
LIMIT 1;
