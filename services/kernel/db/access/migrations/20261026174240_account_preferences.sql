-- migrate:up
CREATE TABLE access.account_preferences (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  account_id uuid NOT NULL,
  spoiler_level integer NOT NULL CHECK (spoiler_level BETWEEN 0 AND 2),
  suitability text NOT NULL CHECK (suitability IN ('blur', 'show')),
  version integer NOT NULL CHECK (version > 0),
  PRIMARY KEY (route, account_id),
  CHECK (route = get_byte(uuid_send(account_id), 10) * 256 + get_byte(uuid_send(account_id), 11))
);

-- migrate:down
DROP TABLE access.account_preferences;
