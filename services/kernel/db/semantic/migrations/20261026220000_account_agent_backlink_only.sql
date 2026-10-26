-- migrate:up
ALTER TABLE semantic.account_agent_subject
  DROP CONSTRAINT account_agent_subject_route_account_id_key,
  ADD CONSTRAINT account_agent_subject_account_id_key UNIQUE (account_id),
  ADD CONSTRAINT account_agent_subject_agent_id_key UNIQUE (agent_id);

DROP TABLE semantic.account_agent;

-- migrate:down
CREATE TABLE semantic.account_agent (
  account_id uuid NOT NULL,
  route integer NOT NULL,
  subject_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  verified boolean NOT NULL DEFAULT false,
  receipt_id text,
  PRIMARY KEY (route, account_id),
  CONSTRAINT account_agent_agent_id_key UNIQUE (route, agent_id),
  CONSTRAINT account_agent_account_route_check
    CHECK (route = get_byte(uuid_send(account_id), 10) * 256 + get_byte(uuid_send(account_id), 11)),
  CONSTRAINT account_agent_agent_route_check
    CHECK (route = get_byte(uuid_send(agent_id), 10) * 256 + get_byte(uuid_send(agent_id), 11)),
  CONSTRAINT account_agent_verification_receipt_check
    CHECK ((verified AND receipt_id IS NOT NULL AND length(receipt_id) BETWEEN 1 AND 255)
        OR (NOT verified AND receipt_id IS NULL))
);

INSERT INTO semantic.account_agent (account_id, route, subject_id, agent_id, verified, receipt_id)
SELECT account_id, account_route, subject_id, agent_id, verified, receipt_id
FROM semantic.account_agent_subject;

ALTER TABLE semantic.account_agent_subject
  DROP CONSTRAINT account_agent_subject_account_id_key,
  DROP CONSTRAINT account_agent_subject_agent_id_key,
  ADD CONSTRAINT account_agent_subject_route_account_id_key UNIQUE (route, account_id);
