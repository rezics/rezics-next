SELECT episode.post_id,
       to_char(episode.contributed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS contributed_at
FROM content.conversation_activity_episode AS episode
JOIN content.post AS post
  ON post.route=episode.route AND post.post_id=episode.post_id AND post.thread_id=episode.thread_id
JOIN content.thread AS thread
  ON thread.route=episode.route AND thread.thread_id=episode.thread_id
JOIN content.board AS board
  ON board.route=thread.route AND board.board_id=thread.board_id
LEFT JOIN content.revision AS head
  ON head.route=post.route AND head.thread_id=post.thread_id
    AND head.post_id=post.post_id AND head.revision_id=post.head_revision_id
WHERE episode.route=:route::integer AND episode.thread_id=:thread_id::uuid
  AND episode.native_eligible AND episode.public_eligible AND episode.contributed_at IS NOT NULL
  AND post.availability='available' AND post.visibility='published' AND NOT post.author_erased
  AND head.availability='available'
  AND thread.availability='available' AND thread.visibility='published'
  AND board.visibility='published'
ORDER BY episode.contributed_at DESC, episode.post_id DESC
LIMIT 1;
