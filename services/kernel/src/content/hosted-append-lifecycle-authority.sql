-- The native workflow supplies one exact anchor, never an author reverse scan.
-- Native purge eligibility must have committed before this operation. Do not
-- create that authority here or reuse Post-only purge_completed as completion.
SELECT c.thread_id
FROM content.hosted_catalogue c
JOIN content.post p ON p.route=c.route AND p.post_id=c.catalogue_id AND p.thread_id=c.thread_id
WHERE c.route=:route::integer AND c.catalogue_id=:catalogue_id::uuid
  AND p.author_account_id=:author_account_id::uuid
  AND ((p.availability='erased' AND p.purge_started_at IS NOT NULL)
    OR (p.availability='available' AND p.visibility='published' AND p.author_erased))
FOR UPDATE OF p,c;
