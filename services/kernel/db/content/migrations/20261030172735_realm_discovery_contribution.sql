-- migrate:up
CREATE TABLE content.realm_discovery_contribution (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  thread_id uuid NOT NULL,
  board_id uuid NOT NULL,
  realm_id uuid NOT NULL,
  space_id uuid NOT NULL,
  realm_epoch bigint NOT NULL CHECK (realm_epoch > 0),
  creation_day date NOT NULL,
  created_at timestamptz NOT NULL,
  source_version bigint NOT NULL DEFAULT 1 CHECK (source_version > 0),
  contributing boolean NOT NULL DEFAULT true,
  PRIMARY KEY (route, thread_id),
  FOREIGN KEY (route, thread_id) REFERENCES content.thread(route, thread_id),
  CHECK (route = get_byte(uuid_send(thread_id), 10) * 256 + get_byte(uuid_send(thread_id), 11)),
  CHECK (creation_day = (created_at AT TIME ZONE 'UTC')::date)
);

-- migrate:down
