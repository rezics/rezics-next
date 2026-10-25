-- migrate:up

-- Realm membership lives on the Realm route. Accounts and Realms are external
-- anchors: compensation must record a terminal slot even when publication never
-- inserted a member row, so these tables have no foreign keys.
CREATE TABLE community.realm_member (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  realm_id uuid NOT NULL,
  account_id uuid NOT NULL,
  role text NOT NULL CHECK (role = 'member'),
  valid tstzrange NOT NULL CHECK (NOT isempty(valid)),
  reservation_id uuid NOT NULL,
  transaction_id uuid NOT NULL,
  PRIMARY KEY (route, realm_id, account_id, valid WITHOUT OVERLAPS),
  CHECK (route = get_byte(uuid_send(realm_id), 10) * 256 + get_byte(uuid_send(realm_id), 11))
);

-- Current interval is the temporal primary key. The next seek is a btree on the
-- finite lower bound, and a change is one transaction on this member.
CREATE INDEX realm_member_next ON community.realm_member
  USING btree (route, realm_id, account_id, lower(valid))
  WHERE NOT lower_inf(valid);
CREATE UNIQUE INDEX realm_member_change ON community.realm_member
  (route, realm_id, account_id, transaction_id);
CREATE INDEX realm_member_reservation ON community.realm_member
  (route, realm_id, account_id, reservation_id);

CREATE TABLE community.realm_member_terminal (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  realm_id uuid NOT NULL,
  account_id uuid NOT NULL,
  reservation_id uuid NOT NULL,
  transaction_id uuid NOT NULL,
  at timestamptz NOT NULL CHECK (isfinite(at)),
  PRIMARY KEY (route, realm_id, account_id, reservation_id),
  CHECK (route = get_byte(uuid_send(realm_id), 10) * 256 + get_byte(uuid_send(realm_id), 11))
);

CREATE FUNCTION community.guard_realm_member_terminal() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Realm membership terminal slots are immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER realm_member_terminal_immutable BEFORE UPDATE OR DELETE ON community.realm_member_terminal
FOR EACH ROW EXECUTE FUNCTION community.guard_realm_member_terminal();

-- migrate:down
-- Forward only: committed membership intervals and terminal slots must survive rollback.
