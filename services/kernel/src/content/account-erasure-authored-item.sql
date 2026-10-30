-- unbound: one explicit route scopes every CTE; route propagation through modifying CTEs is not traced
-- Lock only this author's post. A thread index entry locates its opening post.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id,
         :item_kind::text AS item_kind, :item_id::uuid AS item_id
), locked AS MATERIALIZED (
  SELECT p.route, p.post_id, p.thread_id, p.head_revision_id, p.availability, p.visibility,
         p.security_revision
  FROM content.post p CROSS JOIN input i
  WHERE p.route = i.route AND p.author_account_id = i.account_id
    AND p.post_id = CASE WHEN i.item_kind = 'post' THEN i.item_id ELSE (
      SELECT t.first_post_id FROM content.thread t
      WHERE t.route = i.route AND t.thread_id = i.item_id
    ) END
  FOR UPDATE OF p
), page AS MATERIALIZED (
  SELECT r.route, r.post_id, r.revision_id, r.recorded_at, r.availability = 'available' AS changed
  FROM locked p CROSS JOIN input i
  CROSS JOIN LATERAL (
    SELECT r.route, r.post_id, r.revision_id, r.recorded_at, r.availability
    FROM content.revision r
    WHERE r.route = i.route AND r.post_id = p.post_id
      AND r.revision_id <> p.head_revision_id
      AND (r.recorded_at, r.revision_id) > (:after_at::timestamptz, :after_revision::uuid)
    ORDER BY r.recorded_at, r.revision_id
    LIMIT :revision_limit::integer
  ) r
  WHERE p.availability = 'available' AND p.visibility = 'published'
), cleared AS (
  UPDATE content.revision r
  SET body = NULL, body_sha256 = NULL, search_text = NULL, availability = 'erased'
  FROM page p CROSS JOIN input i
  WHERE r.route = i.route AND r.post_id = p.post_id
    AND r.revision_id = p.revision_id AND p.changed
  RETURNING r.revision_id
), erased AS (
  UPDATE content.post p
  SET availability = 'erased', security_revision = p.security_revision + 1,
      purge_started_at = COALESCE(p.purge_started_at, transaction_timestamp())
  FROM locked l CROSS JOIN input i
  WHERE p.route = i.route AND p.post_id = l.post_id
    AND l.availability = 'available' AND l.visibility <> 'published'
  RETURNING p.post_id, p.thread_id, p.security_revision::text
), terminal AS (
  UPDATE content.post p SET purge_started_at = transaction_timestamp()
  FROM locked l CROSS JOIN input i
  WHERE p.route = i.route AND p.post_id = l.post_id
    AND l.availability = 'erased' AND p.purge_started_at IS NULL AND NOT p.purge_completed
  RETURNING p.post_id, p.thread_id, p.security_revision::text AS security_revision
), title_change AS (
  UPDATE content.thread t SET title = NULL,
    review_live = CASE WHEN t.kind = 'review' THEN false ELSE t.review_live END
  FROM locked l LEFT JOIN erased e ON e.post_id = l.post_id CROSS JOIN input i
  WHERE t.route = i.route AND t.thread_id = l.thread_id AND t.first_post_id = l.post_id
    AND (l.availability = 'erased' OR e.post_id IS NOT NULL) AND t.title IS NOT NULL
  RETURNING t.thread_id
)
SELECT l.thread_id::text, COALESCE(e.post_id, x.post_id)::text AS erased_post_id,
       COALESCE(e.security_revision, x.security_revision) AS security_revision,
       (SELECT count(*)::integer FROM page) AS revisions,
       (SELECT count(*)::integer FROM cleared) AS cleared,
       (SELECT count(*)::integer FROM title_change) AS titles,
       (SELECT recorded_at::text FROM page ORDER BY recorded_at DESC, revision_id DESC LIMIT 1) AS after_at,
       (SELECT revision_id::text FROM page ORDER BY recorded_at DESC, revision_id DESC LIMIT 1) AS after_revision
FROM locked l LEFT JOIN erased e ON e.post_id = l.post_id
LEFT JOIN terminal x ON x.post_id = l.post_id;
