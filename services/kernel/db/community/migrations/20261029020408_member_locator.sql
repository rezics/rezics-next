-- migrate:up
CREATE TABLE community.member_locator (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  account_id uuid NOT NULL,
  realm_route integer NOT NULL CHECK (realm_route BETWEEN 0 AND 65535),
  realm_id uuid NOT NULL,
  PRIMARY KEY (route, account_id, realm_id),
  CHECK (route = get_byte(uuid_send(account_id), 10) * 256 + get_byte(uuid_send(account_id), 11)),
  CHECK (realm_route = get_byte(uuid_send(realm_id), 10) * 256 + get_byte(uuid_send(realm_id), 11))
);

-- Source-local intents survive outbox retention and are acknowledged only after
-- the account-partition locator commits. The leading account key bounds pending
-- reads to this account's own outstanding interval-committing events.
CREATE TABLE community.member_locator_pending (
  account_id uuid NOT NULL,
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  realm_id uuid NOT NULL,
  transaction_id uuid NOT NULL,
  PRIMARY KEY (account_id, route, realm_id, transaction_id),
  CHECK (route = get_byte(uuid_send(realm_id), 10) * 256 + get_byte(uuid_send(realm_id), 11))
);

CREATE FUNCTION community.record_member_locator_pending() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('community.member_erasure_account', true) IS DISTINCT FROM NEW.account_id::text THEN
    INSERT INTO community.member_locator_pending (account_id, route, realm_id, transaction_id)
    VALUES (NEW.account_id, NEW.route, NEW.realm_id, NEW.transaction_id)
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER member_locator_pending AFTER INSERT OR UPDATE OF valid ON community.realm_member
FOR EACH ROW EXECUTE FUNCTION community.record_member_locator_pending();
CREATE TRIGGER member_locator_terminal_pending AFTER INSERT ON community.realm_member_terminal
FOR EACH ROW EXECUTE FUNCTION community.record_member_locator_pending();

-- Backfill start
INSERT INTO community.member_locator (route, account_id, realm_route, realm_id)
SELECT DISTINCT get_byte(uuid_send(account_id), 10) * 256 + get_byte(uuid_send(account_id), 11),
       account_id, route, realm_id
FROM (
  SELECT route, account_id, realm_id FROM community.realm_member
  UNION
  SELECT route, account_id, realm_id FROM community.realm_member_terminal
) AS membership
ON CONFLICT DO NOTHING;
-- Backfill end

-- Ordinary membership never removes terminal reservations. Terminal account
-- erasure uses a transaction-local, account-specific capability to purge them.
CREATE OR REPLACE FUNCTION community.guard_realm_member_terminal() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('community.member_erasure_account', true) = OLD.account_id::text THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Realm membership terminal slots are immutable' USING ERRCODE = '23514';
END;
$$;

-- migrate:down
-- Forward only: retain membership locators and unfinished source intents.
