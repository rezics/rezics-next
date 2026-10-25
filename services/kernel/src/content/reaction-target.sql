-- One bounded eligibility observation in the target home. The remote board is
-- deliberately only a reference here and is checked on its own native anchor.
WITH RECURSIVE input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :id::uuid AS id, :kind::text AS kind
), root AS MATERIALIZED (
  SELECT t.* FROM input i
  JOIN content.thread t ON t.route=i.route AND t.thread_id=i.id WHERE i.kind='thread'
  UNION ALL
  SELECT t.* FROM input i
  JOIN content.post p ON p.route=i.route AND p.post_id=i.id
  JOIN content.thread t ON t.route=i.route AND t.thread_id=p.thread_id WHERE i.kind='post'
), ancestors AS (
  SELECT p.*, 1 AS depth FROM root t CROSS JOIN input i
  JOIN content.post p ON p.route=i.route AND p.post_id=CASE WHEN i.kind='thread' THEN t.first_post_id ELSE i.id END
    AND p.thread_id=t.thread_id
  UNION ALL
  SELECT p.*, a.depth+1 FROM ancestors a
  CROSS JOIN LATERAL (
    SELECT p.* FROM content.post p
    WHERE p.route=a.route AND p.post_id=a.reply_to_post_id AND p.thread_id=a.thread_id
    OFFSET 0
  ) p WHERE a.depth < 33
)
SELECT 'thread'::text AS kind, t.thread_id AS id, NULL::uuid AS parent_id,
       t.thread_id, t.board_id, t.author_account_id AS author_id,
       t.visibility, t.availability, 0 AS depth
FROM root t
UNION ALL
SELECT 'post', p.post_id, p.reply_to_post_id, p.thread_id, NULL::uuid, p.author_account_id,
       p.visibility, CASE WHEN p.availability='erased' THEN 'erased' ELSE r.availability END, p.depth
FROM ancestors p
JOIN content.revision r ON r.route=p.route AND r.revision_id=p.head_revision_id
  AND r.thread_id=p.thread_id AND r.post_id=p.post_id
ORDER BY depth;
