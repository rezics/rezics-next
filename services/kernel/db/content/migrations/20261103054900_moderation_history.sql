-- migrate:up
CREATE TABLE content.moderation_decision_board (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  board_id uuid NOT NULL,
  decision_id uuid NOT NULL,
  target_kind text NOT NULL CHECK (target_kind IN ('thread', 'post')),
  target_id uuid NOT NULL,
  decided_at timestamptz NOT NULL,
  PRIMARY KEY (route, board_id, decision_id),
  CHECK (route = get_byte(uuid_send(board_id), 10) * 256 + get_byte(uuid_send(board_id), 11)),
  CHECK (get_byte(uuid_send(decision_id), 10) * 256 + get_byte(uuid_send(decision_id), 11)
    = get_byte(uuid_send(target_id), 10) * 256 + get_byte(uuid_send(target_id), 11))
);
CREATE INDEX moderation_decision_board_page_idx ON content.moderation_decision_board
  (route, board_id, decided_at DESC, decision_id DESC) INCLUDE (target_kind, target_id);

-- migrate:down
DROP TABLE content.moderation_decision_board;
