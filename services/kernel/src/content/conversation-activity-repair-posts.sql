SELECT post.route, post.thread_id, post.post_id, thread.first_post_id,
       to_char(post.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
       post.visibility AS post_visibility,
       post.availability AS post_availability,
       post.author_erased,
       post.security_revision::text AS security_revision,
       head.availability AS head_availability,
       thread.visibility AS thread_visibility,
       thread.availability AS thread_availability,
       thread.security_revision::text AS thread_security_revision,
       board.board_id,
       board.visibility AS board_visibility,
       board.security_revision::text AS board_security_revision,
       stored.contributed_at IS NOT NULL AS has_saved_contribution,
       to_char(COALESCE(stored.contributed_at, publication.activity_at) AT TIME ZONE 'UTC',
         'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS contributed_at,
       publication.activity_at IS NOT NULL AS has_publication_source
FROM content.post AS post
JOIN content.thread AS thread
  ON thread.route = post.route AND thread.thread_id = post.thread_id
JOIN content.board AS board
  ON board.route = thread.route AND board.board_id = thread.board_id
LEFT JOIN content.revision AS head
  ON head.route = post.route AND head.thread_id = post.thread_id
    AND head.post_id = post.post_id AND head.revision_id = post.head_revision_id
LEFT JOIN content.conversation_activity_episode AS stored
  ON stored.route = post.route AND stored.post_id = post.post_id
LEFT JOIN LATERAL (
  SELECT (outbox.data ->> 'activityAt')::timestamptz AS activity_at
  FROM core.outbox AS outbox
  WHERE outbox.partition_no = :partition_no::integer
    AND outbox.subject = post.post_id::text
    AND outbox.type = 'com.rezics.content.post.published.v1'
    AND outbox.payload_state = 'present'
    AND outbox.data ->> 'itemId' = post.post_id::text
    AND outbox.data ->> 'threadId' = post.thread_id::text
  ORDER BY outbox.position, outbox.event_seq
  LIMIT 1
) AS publication ON stored.contributed_at IS NULL
WHERE post.route = :route::integer AND post.thread_id = :thread_id::uuid
  AND post.availability='available' AND post.visibility='published' AND NOT post.author_erased
  AND (post.created_at, post.post_id) >
      (COALESCE(:after_created_at::nullable(timestamptz), '-infinity'::timestamptz),
       COALESCE(:after_post_id::nullable(uuid), '00000000-0000-0000-0000-000000000000'::uuid))
ORDER BY post.created_at, post.post_id
LIMIT :limit::integer;
