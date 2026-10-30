-- migrate:up
-- Disposable references, with neither report evidence nor authority attached.
CREATE TABLE content.board_report_candidate (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  board_id uuid NOT NULL,
  target_kind text NOT NULL CHECK (target_kind IN ('board', 'thread', 'post')),
  target_id uuid NOT NULL,
  report_route integer NOT NULL CHECK (report_route BETWEEN 0 AND 65535),
  report_id uuid NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (route, board_id, report_id),
  CHECK (route = get_byte(uuid_send(board_id), 10) * 256 + get_byte(uuid_send(board_id), 11)),
  CHECK (report_route = get_byte(uuid_send(report_id), 10) * 256 + get_byte(uuid_send(report_id), 11))
);
CREATE INDEX board_report_candidate_page_idx ON content.board_report_candidate
  (route, board_id, created_at DESC, report_id DESC) INCLUDE (report_route, target_kind, target_id);

-- migrate:down
DROP TABLE content.board_report_candidate;
