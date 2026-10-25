-- migrate:up

-- The Realm owns both the record and its current-ban list. Accounts are external
-- anchors; no account-partition lookup or content projection participates here.
CREATE TABLE community.realm_ban (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  realm_id uuid NOT NULL,
  account_id uuid NOT NULL,
  valid tstzrange NOT NULL CHECK (NOT isempty(valid)),
  reason text NOT NULL CHECK (char_length(reason) <= 1024),
  actor uuid NOT NULL,
  transaction_id uuid NOT NULL,
  PRIMARY KEY (route, realm_id, account_id, valid WITHOUT OVERLAPS),
  CHECK (route = get_byte(uuid_send(realm_id), 10) * 256 + get_byte(uuid_send(realm_id), 11))
);

-- History never widens the current keyset window or the point mutation probe.
-- Cover the interval returned by the one-row current-key seek.
CREATE UNIQUE INDEX realm_ban_current ON community.realm_ban (route, realm_id, account_id)
  INCLUDE (valid)
  WHERE upper_inf(valid);

-- migrate:down
-- Forward only: preserve committed ban intervals.
