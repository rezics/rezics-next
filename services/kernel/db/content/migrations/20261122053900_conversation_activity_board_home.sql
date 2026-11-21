-- migrate:up
ALTER TABLE content.conversation_activity_episode
  DROP CONSTRAINT conversation_activity_episode_coverage_board_route_check;
CREATE INDEX conversation_activity_board_members ON content.thread (board_id, thread_id) INCLUDE (route);
DROP INDEX content.conversation_activity_board_threads_idx;

-- Revisiting the bounded source pages finds omitted openings on independently routed boards.
UPDATE content.conversation_activity_repair_frontier f
   SET complete=false, after_route=NULL, after_thread_id=NULL, cut_epoch=p.epoch, cut_position=p.position
  FROM core.partition p WHERE p.partition_no=f.partition_no;
UPDATE content.conversation_activity_episode e
   SET coverage_state='uncovered', repair_generation=NULL
  FROM content.thread t
 WHERE e.opening AND e.coverage_state='unrecoverable'
   AND (t.route,t.thread_id)=(e.route,e.thread_id)
   AND t.route<>get_byte(uuid_send(t.board_id),10)*256+get_byte(uuid_send(t.board_id),11);

-- migrate:down
UPDATE content.conversation_activity_episode
   SET coverage_state='uncovered', coverage_board_id=NULL, coverage_board_security_revision=NULL,
       repair_generation=NULL
 WHERE coverage_board_id IS NOT NULL
   AND route<>get_byte(uuid_send(coverage_board_id),10)*256+get_byte(uuid_send(coverage_board_id),11);
ALTER TABLE content.conversation_activity_episode
  ADD CONSTRAINT conversation_activity_episode_coverage_board_route_check
    CHECK (coverage_board_id IS NULL OR route=get_byte(uuid_send(coverage_board_id),10)*256+
                                            get_byte(uuid_send(coverage_board_id),11));
CREATE INDEX conversation_activity_board_threads_idx ON content.thread (route, board_id, thread_id);
DROP INDEX content.conversation_activity_board_members;
