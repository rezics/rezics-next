-- migrate:up
ALTER TABLE semantic.account_agent
  ADD COLUMN agent_id uuid,
  ADD COLUMN verified boolean NOT NULL DEFAULT false,
  ADD COLUMN receipt_id text;

UPDATE semantic.account_agent SET agent_id = subject_id;

ALTER TABLE semantic.account_agent
  ALTER COLUMN agent_id SET NOT NULL,
  DROP CONSTRAINT account_agent_pkey,
  DROP CONSTRAINT account_agent_route_subject_id_key,
  DROP CONSTRAINT account_agent_subject_route_check,
  DROP CONSTRAINT account_agent_route_check,
  ADD CONSTRAINT account_agent_pkey PRIMARY KEY (route, account_id),
  ADD CONSTRAINT account_agent_agent_id_key UNIQUE (route, agent_id),
  ADD CONSTRAINT account_agent_account_route_check
    CHECK (route = get_byte(uuid_send(account_id), 10) * 256 + get_byte(uuid_send(account_id), 11)),
  ADD CONSTRAINT account_agent_agent_route_check
    CHECK (route = get_byte(uuid_send(agent_id), 10) * 256 + get_byte(uuid_send(agent_id), 11)),
  ADD CONSTRAINT account_agent_verification_receipt_check
    CHECK ((verified AND receipt_id IS NOT NULL AND length(receipt_id) BETWEEN 1 AND 255)
        OR (NOT verified AND receipt_id IS NULL));

ALTER TABLE semantic.revision ADD COLUMN verification_receipt_id text;

CREATE TABLE semantic.account_agent_subject (
  route integer NOT NULL,
  account_route integer NOT NULL,
  subject_id uuid NOT NULL,
  account_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  verified boolean NOT NULL DEFAULT false,
  receipt_id text,
  PRIMARY KEY (route, subject_id),
  UNIQUE (route, account_id),
  CONSTRAINT account_agent_subject_route_check
    CHECK (route = get_byte(uuid_send(subject_id), 10) * 256 + get_byte(uuid_send(subject_id), 11)),
  CONSTRAINT account_agent_subject_account_route_check
    CHECK (account_route = get_byte(uuid_send(account_id), 10) * 256 + get_byte(uuid_send(account_id), 11)),
  CONSTRAINT account_agent_subject_receipt_check
    CHECK ((verified AND receipt_id IS NOT NULL AND length(receipt_id) BETWEEN 1 AND 255)
        OR (NOT verified AND receipt_id IS NULL))
);

CREATE TABLE semantic.account_agent_moved_link (
  route integer NOT NULL,
  receipt_id text NOT NULL,
  account_id uuid NOT NULL,
  survivor uuid NOT NULL,
  moved_from uuid NOT NULL,
  statement_id uuid NOT NULL,
  PRIMARY KEY (route, receipt_id, moved_from, statement_id),
  CONSTRAINT account_agent_moved_link_receipt_check CHECK (length(receipt_id) BETWEEN 1 AND 255)
);

-- migrate:down
DROP TABLE semantic.account_agent_moved_link;
DROP TABLE semantic.account_agent_subject;
ALTER TABLE semantic.revision DROP COLUMN verification_receipt_id;
ALTER TABLE semantic.account_agent
  DROP CONSTRAINT account_agent_account_route_check,
  DROP CONSTRAINT account_agent_agent_route_check;
UPDATE semantic.account_agent
SET route = get_byte(uuid_send(subject_id), 10) * 256 + get_byte(uuid_send(subject_id), 11);
ALTER TABLE semantic.account_agent
  DROP CONSTRAINT account_agent_verification_receipt_check,
  DROP CONSTRAINT account_agent_agent_id_key,
  DROP CONSTRAINT account_agent_pkey,
  ADD CONSTRAINT account_agent_pkey PRIMARY KEY (account_id),
  ADD CONSTRAINT account_agent_route_subject_id_key UNIQUE (route, subject_id),
  ADD CONSTRAINT account_agent_route_check CHECK (route BETWEEN 0 AND 65535),
  ADD CONSTRAINT account_agent_subject_route_check
    CHECK (route = get_byte(uuid_send(subject_id), 10) * 256 + get_byte(uuid_send(subject_id), 11)),
  DROP COLUMN receipt_id,
  DROP COLUMN verified,
  DROP COLUMN agent_id;
