-- migrate:up
-- Derived delivery decisions; Accounts and current resource Access remain authority.
CREATE TABLE content.notice_finalization (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  recipient_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('reply', 'mention')),
  source_id uuid NOT NULL,
  sent boolean NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (route, recipient_id, kind, source_id),
  CHECK (route = get_byte(uuid_send(recipient_id), 10) * 256 + get_byte(uuid_send(recipient_id), 11))
);
CREATE INDEX notice_finalization_recipient_created_idx
  ON content.notice_finalization (route, recipient_id, created_at, kind, source_id);
CREATE INDEX notice_finalization_route_created_idx
  ON content.notice_finalization (route, created_at, recipient_id, kind, source_id);

-- migrate:down
DROP TABLE content.notice_finalization;
