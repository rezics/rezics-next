-- Reversal supports either a Post/Thread visibility decision or one exact
-- revision decision. Exact reversal changes only that ledger row and Post fence.
WITH input AS NOT MATERIALIZED (
  SELECT :kind::text AS kind, :route::integer AS route, :id::uuid AS id,
         :decision_id::nullable(uuid) AS decision_id
), exact_restriction AS (
  UPDATE content.post_revision_restriction r SET lifted_at=transaction_timestamp()
  FROM input i, content.moderation_decision d
  WHERE i.decision_id IS NOT NULL AND i.kind='post' AND r.route=i.route
    AND r.decision_id=i.decision_id AND r.post_id=i.id AND r.lifted_at IS NULL
    AND d.route=r.route AND d.decision_id=r.decision_id AND d.revision_id=r.revision_id
    AND d.target_kind='post' AND d.target_id=r.post_id
  RETURNING r.route, r.post_id, r.revision_id
), exact_post_change AS (
  UPDATE content.post p SET security_revision=p.security_revision+1
  FROM exact_restriction r
  WHERE p.route=r.route AND p.post_id=r.post_id
  RETURNING p.post_id, p.security_revision::text, r.revision_id
), thread_change AS (
  UPDATE content.thread SET visibility='published', security_revision=security_revision+1
  FROM input i
  WHERE i.decision_id IS NULL AND i.kind='thread' AND content.thread.route=i.route
    AND thread_id=i.id AND visibility='taken_down'
  RETURNING thread_id, security_revision::text
), post_change AS (
  UPDATE content.post SET visibility='published', security_revision=security_revision+1
  FROM input i
  WHERE i.decision_id IS NULL AND i.kind='post' AND content.post.route=i.route
    AND post_id=i.id AND visibility='taken_down'
  RETURNING post_id, security_revision::text
)
SELECT 'thread'::text AS kind, thread_id AS target_id, security_revision, NULL::uuid AS revision_id
FROM thread_change
UNION ALL
SELECT 'post'::text, post_id, security_revision, NULL::uuid FROM post_change
UNION ALL
SELECT 'post'::text, post_id, security_revision, revision_id FROM exact_post_change;
