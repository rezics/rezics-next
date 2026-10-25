SELECT publication_id AS "publicationId",
       to_char(published_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "publishedAt"
FROM community.publication_head
WHERE route = :route::integer AND realm_id = :realm::uuid AND subject_id = :subject::uuid
  AND verdict = 'adopt';
