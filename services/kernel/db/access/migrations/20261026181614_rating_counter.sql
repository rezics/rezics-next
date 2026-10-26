-- migrate:up
-- Keep the controller relation at T without exposing it to rating or scanning
-- account history. This is a private temporal projection of the account row.
CREATE TABLE access.rating_counter_controller (
  route integer NOT NULL,
  account_id uuid NOT NULL,
  effective_at timestamptz NOT NULL,
  controller_id uuid NOT NULL,
  PRIMARY KEY (route, account_id, effective_at),
  CHECK (route = get_byte(uuid_send(account_id), 10) * 256 + get_byte(uuid_send(account_id), 11))
);

-- Existing relations are the baseline; pre-migration history is unavailable.
INSERT INTO access.rating_counter_controller (route, account_id, effective_at, controller_id)
SELECT route, account_id, '-infinity', COALESCE(operator_account_id, account_id)
FROM access.account;

CREATE FUNCTION access.record_rating_controller() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  at timestamptz;
BEGIN
  IF TG_OP = 'INSERT' THEN
    at := '-infinity';
  ELSIF NEW.operator_account_id IS NOT DISTINCT FROM OLD.operator_account_id THEN
    RETURN NEW;
  ELSE
    -- Native relation and deletion commands supply their authoritative T.
    -- Direct relation removal uses the database transaction time.
    at := COALESCE(NULLIF(current_setting('rezics.operator_at', true), '')::timestamptz,
                   transaction_timestamp());
  END IF;
  INSERT INTO access.rating_counter_controller (route, account_id, effective_at, controller_id)
  VALUES (NEW.route, NEW.account_id, at, COALESCE(NEW.operator_account_id, NEW.account_id))
  ON CONFLICT (route, account_id, effective_at) DO UPDATE SET controller_id = EXCLUDED.controller_id;
  RETURN NEW;
END;
$$;

CREATE TRIGGER rating_controller AFTER INSERT OR UPDATE OF operator_account_id ON access.account
FOR EACH ROW EXECUTE FUNCTION access.record_rating_controller();

-- migrate:down
-- Forward only: historical counting relations are required for event replay.
