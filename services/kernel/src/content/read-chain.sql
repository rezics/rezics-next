-- Each branch is an exact route/identity probe. Boards are always invoked on
-- their own independently anchored connection, never joined to thread storage.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :id::uuid AS id, :kind::text AS kind,
         :thread_id::uuid AS thread_id, :include_body::boolean AS include_body
)
SELECT 'board'::text AS kind, b.board_id AS id, NULL::uuid AS thread_id,
       NULL::uuid AS board_id, NULL::uuid AS parent_id, NULL::uuid AS author_id,
       NULL::uuid AS head_id, NULL::uuid AS first_post_id, b.title,
       b.visibility, b.security_revision::text, 'available'::text AS availability,
       b.created_at, NULL::text AS licence, NULL::uuid[] AS subject_ids,
       NULL::uuid[] AS media_ids, NULL::bytea AS body, NULL::bytea AS sha256,
       NULL::timestamptz AS revised_at, NULL::text AS thread_kind,
       b.purpose AS board_purpose, NULL::jsonb AS vote_citation, b.realm_id AS realm_id,
       NULL::timestamptz AS deleted_at, false AS restorable, NULL::uuid AS decision_id
FROM input i JOIN content.board b ON b.route=i.route AND b.board_id=i.id
WHERE i.kind='board'
UNION ALL
SELECT 'thread', t.thread_id, t.thread_id, t.board_id, NULL::uuid, t.author_account_id,
       NULL::uuid, t.first_post_id, t.title, t.visibility, t.security_revision::text,
       t.availability, t.created_at, NULL::text, NULL::uuid[], NULL::uuid[], NULL::bytea, NULL::bytea,
       NULL::timestamptz, t.kind, NULL::text, NULL::jsonb, NULL::uuid, NULL::timestamptz, false, NULL::uuid
FROM input i JOIN content.thread t ON t.route=i.route AND t.thread_id=i.id
WHERE i.kind='thread'
UNION ALL
SELECT 'post', p.post_id, p.thread_id, NULL::uuid, p.reply_to_post_id, p.author_account_id,
       p.head_revision_id, NULL::uuid, NULL::text, p.visibility, p.security_revision::text,
       CASE WHEN p.availability='erased' THEN 'erased' ELSE h.availability END, p.created_at, NULL::text, NULL::uuid[], NULL::uuid[], NULL::bytea, NULL::bytea,
       CASE WHEN h.recorded_transaction_id IS DISTINCT FROM p.recorded_transaction_id THEN h.recorded_at ELSE NULL::timestamptz END,
       NULL::text, NULL::text, NULL::jsonb, NULL::uuid, p.deleted_at,
       p.purge_started_at IS NULL AND NOT p.purge_completed AND h.availability='available', d.decision_id
FROM input i JOIN content.post p ON p.route=i.route AND p.post_id=i.id AND p.thread_id=i.thread_id
JOIN content.revision h ON h.route=i.route AND h.thread_id=p.thread_id
  AND h.post_id=p.post_id AND h.revision_id=p.head_revision_id
LEFT JOIN content.moderation_decision d ON d.route=p.route AND d.target_kind='post'
  AND d.target_id=p.post_id AND d.security_revision=p.security_revision
WHERE i.kind='post'
UNION ALL
SELECT 'revision', r.revision_id, r.thread_id, r.board_id, r.post_id, NULL::uuid,
       NULL::uuid, NULL::uuid, NULL::text, NULL::text, NULL::text,
       r.availability, r.recorded_at, r.licence, r.subject_ids, r.media_ids,
       CASE WHEN i.include_body THEN r.body ELSE NULL::bytea END, r.body_sha256, NULL::timestamptz,
       NULL::text, NULL::text, r.vote_citation, NULL::uuid, NULL::timestamptz, false, NULL::uuid
FROM input i JOIN content.revision r ON r.route=i.route AND r.revision_id=i.id AND r.thread_id=i.thread_id
WHERE i.kind='revision';
