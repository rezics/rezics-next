-- migrate:up
DROP TRIGGER thread_identity ON content.thread;
CREATE TRIGGER thread_identity BEFORE UPDATE ON content.thread
FOR EACH ROW EXECUTE FUNCTION content.guard_identity(
  'route', 'thread_id', 'author_account_id', 'board_id', 'first_post_id', 'kind', 'review_subject_id', 'created_at'
);
