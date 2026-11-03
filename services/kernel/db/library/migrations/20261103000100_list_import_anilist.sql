-- migrate:up
CREATE TABLE library.list_import_anilist (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  account_id uuid NOT NULL,
  import_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN -1 AND 199),
  payload jsonb NOT NULL CHECK (octet_length(payload::text) <= 4194304),
  PRIMARY KEY (route, account_id, import_id, ordinal),
  CHECK (route = get_byte(uuid_send(account_id),10)*256+get_byte(uuid_send(account_id),11)),
  CHECK (route = get_byte(uuid_send(import_id),10)*256+get_byte(uuid_send(import_id),11))
);
-- migrate:down
DROP TABLE library.list_import_anilist;
