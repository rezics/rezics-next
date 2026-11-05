-- Source rows share their thread's partition. Containers are separate full-key
-- batches: this statement never joins a thread to its board's partition.
WITH RECURSIVE input AS NOT MATERIALIZED (
  SELECT k.route, k.id, :kind::text AS kind FROM jsonb_to_recordset(:keys::jsonb) AS k(route integer, id uuid)
), source AS (
  SELECT i.route, i.id, t.thread_id, t.first_post_id AS post_id,
         NULL::uuid AS revision_id, NULL::uuid AS creator_id, NULL::uuid AS subject_id,
         NULL::bytea AS digest, NULL::text AS licence, NULL::text AS state
  FROM input i CROSS JOIN LATERAL (
    SELECT thread_id, first_post_id FROM content.thread
    WHERE route=i.route AND thread_id=i.id LIMIT 1
  ) t WHERE i.kind='thread'
  UNION ALL
  SELECT i.route, i.id, p.thread_id, p.post_id, NULL::uuid, NULL::uuid,
         NULL::uuid, NULL::bytea, NULL::text, NULL::text
  FROM input i CROSS JOIN LATERAL (
    SELECT thread_id, post_id FROM content.post
    WHERE route=i.route AND post_id=i.id LIMIT 1
  ) p WHERE i.kind='post'
  UNION ALL
  SELECT i.route, i.id, e.thread_id, e.post_id, e.revision_id, e.creator_account_id,
         e.target_subject_id, e.body_sha256, e.licence, e.state
  FROM input i CROSS JOIN LATERAL (
    SELECT thread_id, post_id, revision_id, creator_account_id, target_subject_id,
           body_sha256, licence, state
    FROM content.edition WHERE route=i.route AND edition_id=i.id LIMIT 1
  ) e WHERE i.kind='edition'
), roots AS (
  SELECT s.*, t.board_id, t.visibility AS thread_visibility
  FROM source s CROSS JOIN LATERAL (
    SELECT board_id, visibility FROM content.thread
    WHERE route=s.route AND thread_id=s.thread_id AND availability='available' LIMIT 1
  ) t
), ancestry AS (
  SELECT r.route, r.id, r.thread_id, p.post_id, p.reply_to_post_id AS parent_id,
         p.author_account_id, p.visibility, p.availability, h.availability AS head_availability,
         1 AS depth, ARRAY[p.post_id] AS path
  FROM roots r CROSS JOIN LATERAL (
    SELECT post_id, reply_to_post_id, author_account_id, visibility, availability, head_revision_id
    FROM content.post WHERE route=r.route AND thread_id=r.thread_id AND post_id=r.post_id LIMIT 1
  ) p CROSS JOIN LATERAL (
    SELECT availability FROM content.revision WHERE route=r.route AND thread_id=r.thread_id
      AND post_id=p.post_id AND revision_id=p.head_revision_id LIMIT 1
  ) h
  UNION ALL
  SELECT a.route, a.id, a.thread_id, p.post_id, p.reply_to_post_id, p.author_account_id,
         p.visibility, p.availability, h.availability, a.depth+1, a.path || p.post_id
  FROM ancestry a CROSS JOIN LATERAL (
    SELECT post_id, reply_to_post_id, author_account_id, visibility, availability, head_revision_id
    FROM content.post WHERE route=a.route AND thread_id=a.thread_id AND post_id=a.parent_id LIMIT 1
  ) p CROSS JOIN LATERAL (
    SELECT availability FROM content.revision WHERE route=a.route AND thread_id=a.thread_id
      AND post_id=p.post_id AND revision_id=p.head_revision_id LIMIT 1
  ) h
  WHERE a.depth < :max_posts::integer AND NOT p.post_id=ANY(a.path)
)
SELECT r.id, r.board_id, r.thread_id, r.thread_visibility,
       r.creator_id, r.subject_id, r.state,
       jsonb_agg(jsonb_build_object('id',a.post_id,'public',a.visibility='published',
         'selected',a.depth=1) ORDER BY a.depth) AS posts
FROM roots r JOIN ancestry a ON a.route=r.route AND a.id=r.id
WHERE r.thread_visibility IN ('published','protected')
  AND (r.state IS NULL OR (
    (r.state='published' OR r.creator_id=:actor_id::uuid)
    AND EXISTS (
      SELECT 1 FROM content.revision v WHERE v.route=r.route AND v.thread_id=r.thread_id
        AND v.post_id=r.post_id AND v.revision_id=r.revision_id AND v.availability='available'
        AND v.body_sha256=r.digest AND v.licence=r.licence AND r.subject_id=ANY(v.subject_ids)
      LIMIT 1
    )
  ))
GROUP BY r.id,r.board_id,r.thread_id,r.thread_visibility,r.creator_id,r.subject_id,r.state
HAVING bool_and(a.visibility IN ('published','protected') AND a.availability='available'
                AND a.head_availability='available')
   AND bool_or(a.parent_id IS NULL)
   AND bool_and(a.depth<>1 OR r.creator_id IS NULL OR a.author_account_id=r.creator_id);
