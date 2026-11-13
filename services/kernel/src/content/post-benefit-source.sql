SELECT p.route, p.thread_id AS "threadId", p.post_id AS "postId",
       p.author_account_id AS "creatorAccountId", p.head_revision_id AS "revisionId",
       encode(r.body_sha256, 'hex') AS sha256, r.licence, r.subject_ids AS "subjectIds",
       p.visibility AS "postVisibility", p.availability AS "postAvailability", p.deleted_at AS "deletedAt",
       t.visibility AS "threadVisibility", t.availability AS "threadAvailability",
       b.visibility AS "boardVisibility", b.availability AS "boardAvailability"
FROM content.post p
JOIN content.revision r ON r.route=p.route AND r.thread_id=p.thread_id
  AND r.post_id=p.post_id AND r.revision_id=p.head_revision_id
JOIN content.thread t ON t.route=p.route AND t.thread_id=p.thread_id
JOIN content.board b ON b.route=t.route AND b.board_id=t.board_id
WHERE p.route=:route AND p.post_id=:post_id
  AND p.availability='available' AND p.deleted_at IS NULL
  AND r.availability='available' AND r.body IS NOT NULL AND r.body_sha256=sha256(r.body);
