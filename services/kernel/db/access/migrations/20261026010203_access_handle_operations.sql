-- migrate:up
-- A held reservation is deliberately independent of the pending TTL. It can
-- only be released after an account-local terminal operation proves publication
-- impossible. Pausing a coordinator never makes a published handle stealable.
ALTER TABLE access.handle_claim
  ADD COLUMN hold_operation_id text,
  ADD COLUMN hold_expected_handle text;
ALTER TABLE access.account ADD COLUMN handle_operation_id text;

CREATE TABLE access.lifecycle_handle_effect (
  route integer NOT NULL,
  normalized_handle text NOT NULL,
  account_id uuid NOT NULL,
  reservation_id uuid NOT NULL,
  operation_id text NOT NULL,
  effect text NOT NULL CHECK (effect IN ('active', 'reserved')),
  transaction_id uuid NOT NULL,
  PRIMARY KEY (route, normalized_handle, account_id, reservation_id, operation_id, effect)
);

CREATE TABLE access.lifecycle_handle_operation (
  route integer NOT NULL,
  account_id uuid NOT NULL,
  operation_id text NOT NULL,
  handle text NOT NULL,
  reservation_id uuid NOT NULL,
  expected_handle text,
  old_reservation_id uuid,
  state text NOT NULL CHECK (state IN ('published', 'completed', 'cancelled')),
  transaction_id uuid NOT NULL,
  PRIMARY KEY (route, account_id, operation_id),
  CHECK (route = get_byte(uuid_send(account_id), 10) * 256 + get_byte(uuid_send(account_id), 11))
);

CREATE TABLE access.lifecycle_registration_expiry (
  route integer NOT NULL,
  account_id uuid NOT NULL,
  reservation_id uuid NOT NULL,
  handle text NOT NULL,
  transaction_id uuid NOT NULL,
  PRIMARY KEY (route, account_id, reservation_id),
  CHECK (route = get_byte(uuid_send(account_id), 10) * 256 + get_byte(uuid_send(account_id), 11))
);

-- migrate:down
-- Forward only: publication barriers and terminal operation proofs are durable.
