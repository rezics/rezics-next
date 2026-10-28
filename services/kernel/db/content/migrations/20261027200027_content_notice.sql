-- migrate:up
CREATE TABLE content.notice (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  recipient_id uuid NOT NULL,
  notice_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('reply', 'mention', 'moderation_decision')),
  actor_id uuid,
  thread_id uuid,
  post_id uuid,
  decision_id uuid,
  report_id uuid,
  source_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (route, notice_id),
  CHECK (route = get_byte(uuid_send(recipient_id), 10) * 256 + get_byte(uuid_send(recipient_id), 11)),
  CHECK (route = get_byte(uuid_send(notice_id), 10) * 256 + get_byte(uuid_send(notice_id), 11))
);

CREATE UNIQUE INDEX notice_recipient_kind_source_idx
  ON content.notice (route, recipient_id, kind, source_id);
CREATE INDEX notice_recipient_created_idx
  ON content.notice (route, recipient_id, created_at DESC, notice_id DESC);
CREATE INDEX notice_route_created_idx
  ON content.notice (route, created_at, notice_id);

CREATE TABLE content.notice_seen (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  account_id uuid NOT NULL,
  seen_notice_id uuid NOT NULL,
  seen_at timestamptz NOT NULL,
  PRIMARY KEY (route, account_id),
  CHECK (route = get_byte(uuid_send(account_id), 10) * 256 + get_byte(uuid_send(account_id), 11)),
  CHECK (route = get_byte(uuid_send(seen_notice_id), 10) * 256 + get_byte(uuid_send(seen_notice_id), 11))
);

-- migrate:down
DROP TABLE content.notice_seen;
DROP TABLE content.notice;
