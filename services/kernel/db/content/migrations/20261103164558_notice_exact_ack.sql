-- migrate:up
CREATE TABLE content.notice_ack (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  account_id uuid NOT NULL,
  notice_id uuid NOT NULL,
  acknowledged_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (route, account_id, notice_id),
  FOREIGN KEY (route, notice_id) REFERENCES content.notice(route, notice_id) ON DELETE CASCADE,
  CHECK (route = get_byte(uuid_send(account_id), 10) * 256 + get_byte(uuid_send(account_id), 11)),
  CHECK (route = get_byte(uuid_send(notice_id), 10) * 256 + get_byte(uuid_send(notice_id), 11))
);

-- migrate:down
DROP TABLE content.notice_ack;
