-- migrate:up
ALTER TABLE content.moderation_decision
  ADD COLUMN recorded_transaction_id uuid,
  ADD COLUMN board_id uuid;
ALTER TABLE content.moderation_decision_board
  DROP CONSTRAINT moderation_decision_board_target_kind_check,
  ADD CONSTRAINT moderation_decision_board_target_kind_check CHECK (target_kind IN ('board', 'thread', 'post'));
CREATE INDEX moderation_decision_board_kind_page_idx
  ON content.moderation_decision_board (route, board_id, target_kind, decided_at DESC, decision_id DESC)
  INCLUDE (target_id);

-- migrate:down
ALTER TABLE content.moderation_decision
  DROP COLUMN recorded_transaction_id,
  DROP COLUMN board_id;
DROP INDEX content.moderation_decision_board_kind_page_idx;
DELETE FROM content.moderation_decision_board WHERE target_kind = 'board';
ALTER TABLE content.moderation_decision_board
  DROP CONSTRAINT moderation_decision_board_target_kind_check,
  ADD CONSTRAINT moderation_decision_board_target_kind_check CHECK (target_kind IN ('thread', 'post'));
