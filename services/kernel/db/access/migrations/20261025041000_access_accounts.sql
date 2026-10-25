-- migrate:up
CREATE SCHEMA access;

CREATE TABLE access.account (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  account_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('actor', 'organization')),
  handle text COLLATE "C" CHECK (handle ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  display_name text,
  avatar_url text,
  biography text,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'active', 'suspended', 'deleted')),
  operator_account_id uuid,
  controller_id uuid,
  birth_date date,
  content_preferences jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(content_preferences) = 'object'),
  suspension_reason text,
  minimum_authn_epoch bigint NOT NULL DEFAULT 1 CHECK (minimum_authn_epoch > 0),
  transaction_id uuid NOT NULL,
  PRIMARY KEY (route, account_id),
  CHECK (route = get_byte(uuid_send(account_id), 10) * 256 + get_byte(uuid_send(account_id), 11)),
  CHECK (operator_account_id IS NULL OR (kind = 'actor' AND operator_account_id <> account_id))
);

-- These checks use only OLD and NEW: no lookup of an operator or any other partition.
CREATE FUNCTION access.guard_account_identity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.account_id IS DISTINCT FROM OLD.account_id
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.route IS DISTINCT FROM OLD.route THEN
    RAISE EXCEPTION 'Account ID, kind and route are immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.minimum_authn_epoch < OLD.minimum_authn_epoch THEN
    RAISE EXCEPTION 'Authentication epoch floor cannot decrease' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER account_identity BEFORE UPDATE ON access.account
FOR EACH ROW EXECUTE FUNCTION access.guard_account_identity();

-- Routing the normalized key deterministically makes this one namespace on every node.
-- Presentation input must be explicitly ASCII case-folded before writing; invalid input is rejected.
CREATE TABLE access.handle_claim (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  normalized_handle text COLLATE "C" NOT NULL CHECK (normalized_handle ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  account_id uuid NOT NULL,
  state text NOT NULL CHECK (state IN ('pending', 'active', 'reserved')),
  expires_at timestamptz,
  reserved_until timestamptz,
  transaction_id uuid NOT NULL,
  PRIMARY KEY (route, normalized_handle),
  CHECK (route = get_byte(sha256(convert_to(normalized_handle, 'UTF8')), 0) * 256
               + get_byte(sha256(convert_to(normalized_handle, 'UTF8')), 1)),
  CHECK ((state = 'pending' AND expires_at IS NOT NULL AND reserved_until IS NULL)
      OR (state = 'active' AND expires_at IS NULL AND reserved_until IS NULL)
      OR (state = 'reserved' AND expires_at IS NULL AND reserved_until IS NOT NULL))
);

-- Command integration must enforce organization kind, member eligibility and at least one owner.
-- Member IDs are references, never foreign keys into another account partition.
CREATE TABLE access.organization_member (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  organization_id uuid NOT NULL,
  member_account_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('owner', 'member')),
  valid tstzrange NOT NULL CHECK (NOT isempty(valid)),
  transaction_id uuid NOT NULL,
  PRIMARY KEY (route, organization_id, member_account_id, valid WITHOUT OVERLAPS),
  CHECK (route = get_byte(uuid_send(organization_id), 10) * 256 + get_byte(uuid_send(organization_id), 11))
);

-- migrate:down
-- Forward only: account identity and handle reservations must never be discarded by rollback.
