-- migrate:up
-- Historic creation time is unknown: migration time starts a conservative age window.
ALTER TABLE access.account
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT statement_timestamp() CHECK (isfinite(created_at)),
  ADD COLUMN rate_tier text NOT NULL DEFAULT 'ordinary'
    CHECK (rate_tier IN ('ordinary', 'trusted', 'service')),
  ADD CONSTRAINT account_service_tier_actor CHECK (rate_tier <> 'service' OR kind = 'actor');

CREATE FUNCTION access.guard_account_creation_time() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Account creation time is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER account_creation_time BEFORE UPDATE ON access.account
  FOR EACH ROW EXECUTE FUNCTION access.guard_account_creation_time();

-- migrate:down
DROP TRIGGER account_creation_time ON access.account;
DROP FUNCTION access.guard_account_creation_time();
ALTER TABLE access.account DROP CONSTRAINT account_service_tier_actor,
  DROP COLUMN rate_tier, DROP COLUMN created_at;
