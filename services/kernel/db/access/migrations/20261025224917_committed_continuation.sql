-- migrate:up
CREATE FUNCTION access.committed_continuation_entries(value jsonb, minimum integer, maximum integer, completed boolean)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT jsonb_typeof(value) = 'array'
    AND jsonb_array_length(value) BETWEEN minimum AND maximum
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(value) AS elem
      WHERE jsonb_typeof(elem) <> 'object'
        OR (SELECT count(*) FROM jsonb_object_keys(elem) AS object_key) <> CASE WHEN completed THEN 5 ELSE 4 END
        OR COALESCE(elem->>'step', '') !~ '^[a-z][a-z0-9-]{0,63}$'
        OR COALESCE(length(elem->>'target'), 0) NOT BETWEEN 1 AND 128
        OR COALESCE(length(elem->>'key'), 0) NOT BETWEEN 1 AND 240
        OR COALESCE(elem->>'digest', '') !~ '^[0-9a-f]{64}$'
        OR (completed AND COALESCE(elem->>'receiptId', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
        OR (NOT completed AND jsonb_exists(elem, 'receiptId'))
    );
$$;
CREATE FUNCTION access.committed_continuation_immutable() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (to_jsonb(OLD) - 'expires_at' - 'completions') = (to_jsonb(NEW) - 'expires_at' - 'completions')
    AND (
      (OLD.expires_at = NEW.expires_at
        AND jsonb_array_length(NEW.completions) = jsonb_array_length(OLD.completions) + 1
        AND NEW.completions @> OLD.completions)
      OR (NEW.completions = OLD.completions AND NEW.expires_at > OLD.expires_at AND NEW.expires_at > OLD.created_at)
    )
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Committed continuations are immutable';
END;
$$;
CREATE TABLE access.committed_continuation (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  continuation_id uuid NOT NULL,
  account_id uuid NOT NULL,
  operation_key text NOT NULL CHECK (length(operation_key) BETWEEN 1 AND 128),
  operation_digest text NOT NULL CHECK (operation_digest ~ '^[0-9a-f]{64}$'),
  command_key_prefix text NOT NULL CHECK (command_key_prefix ~ '^wf:[0-9a-f]{64}$'),
  barrier_receipt_id uuid NOT NULL,
  barrier_transaction_id uuid NOT NULL,
  minimum_authn_epoch bigint NOT NULL CHECK (minimum_authn_epoch > 0),
  prior_handle text CHECK (prior_handle IS NULL OR prior_handle ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  prior_operator_account_id uuid,
  prior_reservation_id uuid,
  allowlist jsonb NOT NULL,
  digest text NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL,
  committed_expires_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  completions jsonb NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (route, continuation_id),
  UNIQUE (route, operation_key),
  CHECK (route = get_byte(uuid_send(continuation_id), 10) * 256 + get_byte(uuid_send(continuation_id), 11)),
  CHECK (route = get_byte(uuid_send(account_id), 10) * 256 + get_byte(uuid_send(account_id), 11)),
  CHECK (
    (prior_operator_account_id IS NULL AND prior_reservation_id IS NULL)
    OR (prior_operator_account_id IS NOT NULL AND prior_reservation_id IS NOT NULL)
  ),
  CHECK (committed_expires_at = created_at + interval '300 seconds'),
  CHECK (expires_at >= committed_expires_at),
  CHECK (access.committed_continuation_entries(allowlist, 1, 4, false)),
  CHECK (access.committed_continuation_entries(completions, 0, 4, true)),
  FOREIGN KEY (route, account_id) REFERENCES access.account (route, account_id)
);
CREATE TRIGGER committed_continuation_immutable
  BEFORE UPDATE ON access.committed_continuation
  FOR EACH ROW EXECUTE FUNCTION access.committed_continuation_immutable();
-- migrate:down
DROP TABLE access.committed_continuation;
DROP FUNCTION access.committed_continuation_immutable();
DROP FUNCTION access.committed_continuation_entries(jsonb, integer, integer, boolean);
