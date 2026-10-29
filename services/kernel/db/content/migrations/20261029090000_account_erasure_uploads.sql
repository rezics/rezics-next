-- migrate:up
CREATE TABLE content.account_upload (
  route integer NOT NULL,
  account_id uuid NOT NULL,
  phase text NOT NULL CHECK (phase IN ('media', 'fields')),
  id uuid NOT NULL,
  PRIMARY KEY (route, account_id, phase, id),
  CHECK (route = get_byte(uuid_send(account_id), 10) * 256 + get_byte(uuid_send(account_id), 11))
);

-- The account-home projection is a derived locator; source rows remain authoritative.
INSERT INTO content.account_upload (route, account_id, phase, id)
SELECT get_byte(uuid_send(uploader_id), 10) * 256 + get_byte(uuid_send(uploader_id), 11), uploader_id, 'media', media_id
FROM content.media
ON CONFLICT DO NOTHING;
INSERT INTO content.account_upload (route, account_id, phase, id)
SELECT get_byte(uuid_send(author_account_id), 10) * 256 + get_byte(uuid_send(author_account_id), 11), author_account_id, 'fields', id
FROM content.authored_field
ON CONFLICT DO NOTHING;

-- migrate:down
DROP TABLE content.account_upload;
