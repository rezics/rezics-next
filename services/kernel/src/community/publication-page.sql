SELECT subject_id AS "subjectId", publication_id AS "publicationId",
       to_char(published_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "publishedAt"
FROM community.publication_head
WHERE route = :route::integer AND realm_id = :realm::uuid AND verdict = 'adopt'
  AND (published_at, subject_id) < (:after_at::timestamptz, :after_subject::uuid)
ORDER BY published_at DESC, subject_id DESC
LIMIT :limit::integer;
