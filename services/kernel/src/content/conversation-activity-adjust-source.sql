SELECT COALESCE(post.thread_id, episode.thread_id) AS thread_id,
       COALESCE(post.security_revision, episode.security_revision)::text AS security_revision,
       post.post_id,
       post.visibility AS post_visibility,
       post.availability AS post_availability,
       post.author_erased,
       head.availability AS head_availability,
       thread.first_post_id,
       thread.visibility AS thread_visibility,
       thread.availability AS thread_availability,
       thread.security_revision::text AS thread_security_revision,
       board.board_id,
       board.visibility AS board_visibility,
       board.security_revision::text AS board_security_revision,
       episode.opening AS previous_opening,
       episode.native_eligible AS previous_native_eligible,
       episode.public_eligible AS previous_public_eligible,
       to_char(episode.contributed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS saved_contributed_at,
       to_char(publication.activity_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS publication_at
FROM (SELECT :route::integer AS route, :post_id::uuid AS post_id) AS target
LEFT JOIN content.conversation_activity_episode AS episode
  ON episode.route=target.route AND episode.post_id=target.post_id
LEFT JOIN content.post AS post
  ON post.route=target.route AND post.post_id=target.post_id
LEFT JOIN content.thread AS thread
  ON thread.route=target.route AND thread.thread_id=COALESCE(post.thread_id,episode.thread_id)
LEFT JOIN content.board AS board
  ON board.route=thread.route AND board.board_id=thread.board_id
LEFT JOIN content.revision AS head
  ON head.route=post.route AND head.thread_id=post.thread_id
    AND head.post_id=post.post_id AND head.revision_id=post.head_revision_id
LEFT JOIN LATERAL (
  SELECT (outbox.data ->> 'activityAt')::timestamptz AS activity_at
  FROM core.outbox AS outbox
  WHERE outbox.partition_no=:partition_no::integer
    AND outbox.subject=target.post_id::text
    AND outbox.type='com.rezics.content.post.published.v1'
    AND outbox.payload_state='present'
    AND outbox.data ->> 'itemId'=target.post_id::text
    AND outbox.data ->> 'threadId'=COALESCE(post.thread_id,episode.thread_id)::text
  ORDER BY outbox.position,outbox.event_seq
  LIMIT 1
) AS publication ON true;
