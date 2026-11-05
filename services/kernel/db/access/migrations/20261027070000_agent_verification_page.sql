-- migrate:up
CREATE TABLE access.agent_page (
  route integer NOT NULL,
  subject_id uuid NOT NULL,
  account_id uuid NOT NULL,
  verification_receipt_id uuid NOT NULL,
  PRIMARY KEY (route, subject_id),
  CHECK (route = get_byte(uuid_send(subject_id), 10) * 256 + get_byte(uuid_send(subject_id), 11))
);

INSERT INTO access.agent_page (route, subject_id, account_id, verification_receipt_id)
SELECT get_byte(uuid_send(agent_subject_id), 10) * 256 + get_byte(uuid_send(agent_subject_id), 11),
       agent_subject_id, account_id, agent_verification_receipt_id
FROM access.account
WHERE agent_verified;

-- migrate:down
DROP TABLE access.agent_page;
