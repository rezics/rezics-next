WITH input AS NOT MATERIALIZED (
  SELECT k.route, k.thread_id
  FROM jsonb_to_recordset(:keys::jsonb) AS k(route integer, thread_id uuid)
)
SELECT input.thread_id,
       thread.board_id,
       thread.security_revision::text AS thread_security_revision,
       thread.visibility AS thread_visibility,
       thread.availability AS thread_availability,
       board.security_revision::text AS board_security_revision,
       board.visibility AS board_visibility,
       board.realm_id,
       COALESCE(board_frontier.generation, 0)::text AS board_generation,
       opening.coverage_state,
       opening.coverage_generation::text AS coverage_generation,
       opening.coverage_epoch,
       opening.coverage_position::text AS coverage_position,
       opening.coverage_event_seq,
       opening.coverage_reply_count::text AS reply_count,
       opening.coverage_latest_post_id,
       to_char(opening.coverage_latest_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS latest_at,
       opening.coverage_thread_security_revision::text AS covered_thread_security_revision,
       opening.coverage_board_id,
       opening.coverage_board_security_revision::text AS covered_board_security_revision,
       opening.coverage_board_generation::text AS covered_board_generation
FROM input
LEFT JOIN content.thread AS thread
  ON thread.route = input.route AND thread.thread_id = input.thread_id
LEFT JOIN content.board AS board
  ON board.route = thread.route AND board.board_id = thread.board_id
LEFT JOIN content.conversation_activity_board_frontier AS board_frontier
  ON board_frontier.route = thread.route AND board_frontier.board_id = thread.board_id
LEFT JOIN content.conversation_activity_episode AS opening
  ON opening.route = thread.route AND opening.post_id = thread.first_post_id
    AND opening.thread_id = thread.thread_id AND opening.opening;
