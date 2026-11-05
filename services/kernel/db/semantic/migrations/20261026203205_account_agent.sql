-- migrate:up
CREATE TABLE semantic.account_agent (
  account_id uuid NOT NULL,
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  subject_id uuid NOT NULL,
  PRIMARY KEY (account_id),
  UNIQUE (route, subject_id),
  CONSTRAINT account_agent_subject_route_check
    CHECK (route = get_byte(uuid_send(subject_id), 10) * 256 + get_byte(uuid_send(subject_id), 11))
);

-- migrate:down
DROP TABLE semantic.account_agent;
