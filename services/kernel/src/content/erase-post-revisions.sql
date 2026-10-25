-- Count only the selected post's retained revision identities at logical commit.
-- The exact revision index prefix never visits another author's history.
SELECT count(*)::text AS revisions
FROM content.revision
WHERE route = :route::integer AND post_id = :id::uuid;
