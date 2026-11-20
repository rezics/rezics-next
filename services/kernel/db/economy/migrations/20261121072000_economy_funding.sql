-- migrate:up
CREATE TABLE economy.funding_intent (
  book_id text NOT NULL,
  intent_id text NOT NULL CHECK (intent_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'),
  wallet_id uuid NOT NULL CHECK (wallet_id <> '00000000-0000-0000-0000-000000000000'),
  asset_id text NOT NULL,
  units bigint NOT NULL CHECK (units > 0),
  direction text NOT NULL CHECK (direction IN ('deposit', 'withdrawal')),
  provider_namespace text NOT NULL CHECK (char_length(provider_namespace) BETWEEN 1 AND 255),
  provider_mode text NOT NULL CHECK (provider_mode IN ('test', 'live')),
  destination_ref text NOT NULL CHECK (char_length(destination_ref) BETWEEN 1 AND 255),
  phase text NOT NULL CHECK (phase IN ('awaiting_hold', 'ready', 'submitted', 'unknown', 'refused', 'confirmed', 'reversed')),
  confirmed_movement_id text CHECK (char_length(confirmed_movement_id) BETWEEN 1 AND 255),
  reversed_units bigint NOT NULL CHECK (reversed_units BETWEEN 0 AND units),
  PRIMARY KEY (book_id, intent_id),
  UNIQUE (book_id, intent_id, provider_namespace, provider_mode),
  FOREIGN KEY (book_id, asset_id) REFERENCES economy.asset,
  CHECK (phase <> 'awaiting_hold' OR direction = 'withdrawal'),
  CHECK ((phase IN ('confirmed', 'reversed')) = (confirmed_movement_id IS NOT NULL)),
  CHECK (confirmed_movement_id IS NOT NULL OR reversed_units = 0),
  CHECK ((phase = 'reversed') = (reversed_units = units))
);

CREATE TABLE economy.funding_evidence (
  provider_namespace text NOT NULL,
  provider_mode text NOT NULL,
  source_kind text NOT NULL CHECK (source_kind IN ('movement', 'refusal')),
  source_id text NOT NULL CHECK (char_length(source_id) BETWEEN 1 AND 255),
  book_id text NOT NULL,
  intent_id text NOT NULL,
  fingerprint text NOT NULL CHECK (char_length(fingerprint) BETWEEN 1 AND 4096),
  recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (provider_namespace, provider_mode, source_kind, source_id),
  FOREIGN KEY (book_id, intent_id, provider_namespace, provider_mode)
    REFERENCES economy.funding_intent (book_id, intent_id, provider_namespace, provider_mode)
);

CREATE TABLE economy.funding_dispatch (
  book_id text NOT NULL,
  intent_id text NOT NULL,
  attempt_id text NOT NULL UNIQUE,
  action text NOT NULL CHECK (action IN ('submit', 'reconcile')),
  due_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  active_claim_id uuid,
  closed_at timestamptz,
  PRIMARY KEY (book_id, intent_id),
  FOREIGN KEY (book_id, intent_id) REFERENCES economy.funding_intent
);

CREATE INDEX funding_dispatch_due_idx ON economy.funding_dispatch (book_id, due_at, intent_id)
  WHERE closed_at IS NULL;

CREATE TABLE economy.funding_dispatch_claim (
  book_id text NOT NULL,
  intent_id text NOT NULL,
  claim_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('submit', 'reconcile')),
  lease_until timestamptz NOT NULL,
  acknowledgment text CHECK (char_length(acknowledgment) BETWEEN 1 AND 4096),
  PRIMARY KEY (book_id, intent_id, claim_id),
  FOREIGN KEY (book_id, intent_id) REFERENCES economy.funding_dispatch
);

ALTER TABLE economy.funding_dispatch ADD CONSTRAINT funding_dispatch_active_claim_fk
  FOREIGN KEY (book_id, intent_id, active_claim_id) REFERENCES economy.funding_dispatch_claim;

CREATE TRIGGER funding_evidence_immutable BEFORE UPDATE OR DELETE ON economy.funding_evidence
  FOR EACH ROW EXECUTE FUNCTION economy.reject_history_edit();

-- migrate:down
-- Forward only: provider evidence and dispatch identities must be preserved.
