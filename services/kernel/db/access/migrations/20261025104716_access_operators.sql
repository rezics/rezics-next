-- migrate:up
ALTER TABLE access.account
  ADD COLUMN operator_relation_version bigint NOT NULL DEFAULT 0 CHECK (operator_relation_version >= 0),
  ADD COLUMN operator_reservation_id uuid;

-- Includes lifecycle tombstones and any trusted relation writer. A relation
-- generation is never reused, even when responsibility returns to an old operator.
CREATE FUNCTION access.advance_operator_relation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.operator_account_id IS DISTINCT FROM OLD.operator_account_id
     OR NEW.operator_reservation_id IS DISTINCT FROM OLD.operator_reservation_id THEN
    NEW.operator_relation_version := OLD.operator_relation_version + 1;
  ELSIF NEW.operator_relation_version IS DISTINCT FROM OLD.operator_relation_version THEN
    RAISE EXCEPTION 'Operator relation version is command owned' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER operator_relation_version BEFORE UPDATE ON access.account
FOR EACH ROW EXECUTE FUNCTION access.advance_operator_relation();

-- Subject-local terminal slots prevent a delayed link after release of a pending
-- reservation. These are not reverse operator authority. Only account owns that.
CREATE TABLE access.operator_relation_slot (
  route integer NOT NULL,
  subject_account_id uuid NOT NULL,
  reservation_id uuid NOT NULL,
  operator_account_id uuid NOT NULL,
  terminal boolean NOT NULL,
  transaction_id uuid NOT NULL,
  PRIMARY KEY (route, subject_account_id, reservation_id),
  CHECK (route = get_byte(uuid_send(subject_account_id), 10) * 256 + get_byte(uuid_send(subject_account_id), 11))
);

-- Private Access authorization, committed BEFORE Auth can issue anything. The
-- receipt lives on the management resource's anchor, where grants are rechecked.
CREATE TABLE access.operator_opening_receipt (
  route integer NOT NULL,
  operator_account_id uuid NOT NULL,
  receipt_id uuid NOT NULL,
  subject_account_id uuid NOT NULL,
  acting_human_id uuid NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('session', 'credential-management')),
  action text NOT NULL,
  client_id text NOT NULL,
  scopes text[] NOT NULL,
  requested_by text,
  human_authn_epoch bigint NOT NULL CHECK (human_authn_epoch > 0),
  human_epoch_floor bigint NOT NULL,
  operator_epoch_floor bigint NOT NULL,
  subject_epoch_floor bigint NOT NULL,
  relation_version bigint NOT NULL,
  reservation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  transaction_id uuid NOT NULL,
  consumed_transaction_id uuid,
  PRIMARY KEY (route, operator_account_id, receipt_id),
  CHECK (route = get_byte(uuid_send(operator_account_id), 10) * 256 + get_byte(uuid_send(operator_account_id), 11)),
  CHECK (expires_at <= created_at + interval '60 seconds')
);

-- migrate:down
-- Forward only: receipt audit and terminal reservation slots are durable.
