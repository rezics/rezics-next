-- migrate:up
CREATE TABLE economy.pending_deposit (
  book_id text NOT NULL,
  asset_id text NOT NULL,
  wallet_id uuid NOT NULL,
  units numeric(39, 0) NOT NULL CHECK (units >= 0),
  PRIMARY KEY (book_id, asset_id, wallet_id),
  FOREIGN KEY (book_id, asset_id) REFERENCES economy.asset
);

LOCK TABLE economy.funding_intent IN SHARE ROW EXCLUSIVE MODE;
INSERT INTO economy.pending_deposit (book_id, asset_id, wallet_id, units)
SELECT book_id, asset_id, wallet_id, sum(units)
FROM economy.funding_intent
WHERE direction = 'deposit' AND phase IN ('submitted', 'unknown')
GROUP BY book_id, asset_id, wallet_id;

CREATE FUNCTION economy.project_pending_deposit() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  was_pending boolean := false;
  is_pending boolean;
BEGIN
  IF NEW.direction <> 'deposit' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    was_pending := OLD.phase IN ('submitted', 'unknown');
  END IF;
  is_pending := NEW.phase IN ('submitted', 'unknown');
  IF is_pending = was_pending THEN
    RETURN NEW;
  END IF;

  IF is_pending THEN
    INSERT INTO economy.pending_deposit AS balance (book_id, asset_id, wallet_id, units)
    VALUES (NEW.book_id, NEW.asset_id, NEW.wallet_id, NEW.units)
    ON CONFLICT (book_id, asset_id, wallet_id) DO UPDATE SET units = balance.units + EXCLUDED.units;
  ELSE
    UPDATE economy.pending_deposit
    SET units = units - NEW.units
    WHERE book_id = NEW.book_id AND asset_id = NEW.asset_id AND wallet_id = NEW.wallet_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Pending deposit projection is missing for a dispatched intent';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER funding_intent_pending_deposit
AFTER INSERT OR UPDATE OF phase ON economy.funding_intent
FOR EACH ROW EXECUTE FUNCTION economy.project_pending_deposit();

-- migrate:down
-- Forward only: keep the wallet projection consistent with dispatched deposit intents.
