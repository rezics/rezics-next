-- migrate:up

-- Account-owned discovery keys. Source rows remain authoritative in their owner partitions.
CREATE TABLE community.party_locator (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  account_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('ban_target', 'ban_actor', 'membership_operation', 'verdict')),
  due_at timestamptz NOT NULL CHECK (isfinite(due_at)),
  owner_route integer NOT NULL CHECK (owner_route BETWEEN 0 AND 65535),
  owner_id uuid NOT NULL,
  key text NOT NULL CHECK (char_length(key) BETWEEN 1 AND 100),
  PRIMARY KEY (route, account_id, kind, due_at, owner_route, owner_id, key),
  CHECK (route = get_byte(uuid_send(account_id), 10) * 256 + get_byte(uuid_send(account_id), 11)),
  CHECK (owner_route = get_byte(uuid_send(owner_id), 10) * 256 + get_byte(uuid_send(owner_id), 11))
);

ALTER TABLE community.realm_ban ALTER COLUMN actor DROP NOT NULL;
ALTER TABLE community.publication ALTER COLUMN actor DROP NOT NULL;
ALTER TABLE community.realm_membership_operation
  ALTER COLUMN member_account_id DROP NOT NULL,
  ALTER COLUMN initiator_account_id DROP NOT NULL,
  ALTER COLUMN actor_client_id DROP NOT NULL,
  ALTER COLUMN actor_scopes DROP NOT NULL,
  ALTER COLUMN actor_authn_epoch DROP NOT NULL,
  ALTER COLUMN original_minimum_authn_epoch DROP NOT NULL;

-- Permit only irreversible attribution minimization, never rewriting the verdict.
CREATE OR REPLACE FUNCTION community.guard_publication() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.actor IS NOT NULL AND NEW.actor IS NULL
     AND (to_jsonb(NEW) - 'actor') = (to_jsonb(OLD) - 'actor') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Publication records are append-only' USING ERRCODE = '23514';
END;
$$;

CREATE OR REPLACE FUNCTION community.guard_realm_membership_operation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  attribution text[] := ARRAY['member_account_id', 'initiator_account_id', 'original_operator_account_id',
    'actor_client_id', 'actor_scopes', 'actor_requested_by', 'actor_authn_epoch',
    'original_minimum_authn_epoch', 'original_delegation_transaction_id', 'original_delegation_issued_valid'];
BEGIN
  IF TG_OP = 'UPDATE'
     AND (to_jsonb(NEW) - attribution) = (to_jsonb(OLD) - attribution)
     AND (NEW.member_account_id IS NULL OR NEW.member_account_id = OLD.member_account_id)
     AND (NEW.initiator_account_id IS NULL OR NEW.initiator_account_id = OLD.initiator_account_id)
     AND (NEW.original_operator_account_id IS NULL OR NEW.original_operator_account_id = OLD.original_operator_account_id)
     AND NEW.actor_client_id IS NULL AND NEW.actor_scopes IS NULL AND NEW.actor_requested_by IS NULL
     AND NEW.actor_authn_epoch IS NULL AND NEW.original_minimum_authn_epoch IS NULL
     AND NEW.original_delegation_transaction_id IS NULL AND NEW.original_delegation_issued_valid IS NULL THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Realm membership operations are immutable' USING ERRCODE = '23514';
END;
$$;

INSERT INTO community.party_locator
SELECT get_byte(uuid_send(account_id), 10) * 256 + get_byte(uuid_send(account_id), 11),
  account_id, 'ban_target', lower(valid), route, realm_id, account_id::text
FROM community.realm_ban;
INSERT INTO community.party_locator
SELECT get_byte(uuid_send(actor), 10) * 256 + get_byte(uuid_send(actor), 11),
  actor, 'ban_actor', lower(valid) + interval '183 days', route, realm_id, account_id::text
FROM community.realm_ban WHERE actor IS NOT NULL;
INSERT INTO community.party_locator
SELECT get_byte(uuid_send(actor), 10) * 256 + get_byte(uuid_send(actor), 11),
  actor, 'verdict', created_at, route, publication_id, publication_id::text
FROM community.publication WHERE actor IS NOT NULL;
INSERT INTO community.party_locator
SELECT DISTINCT get_byte(uuid_send(p.account_id), 10) * 256 + get_byte(uuid_send(p.account_id), 11),
  p.account_id, 'membership_operation', o.requested_at, o.route, o.operation_id, o.operation_id::text
FROM community.realm_membership_operation o
CROSS JOIN LATERAL unnest(ARRAY[o.member_account_id, o.initiator_account_id, o.original_operator_account_id,
  split_part(o.actor_requested_by, ':', 4)::uuid, split_part(o.actor_requested_by, ':', 5)::uuid]) p(account_id)
WHERE p.account_id IS NOT NULL;

-- migrate:down
-- Forward only: restoring erased attribution would violate the account erasure fence.
