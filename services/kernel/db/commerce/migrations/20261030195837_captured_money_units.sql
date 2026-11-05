-- migrate:up
CREATE FUNCTION commerce.valid_money_unit(value jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT value IN (
    '{"system":"stripe-api","exponent":0,"factsVersion":"stripe-money-v1"}'::jsonb,
    '{"system":"stripe-api","exponent":2,"factsVersion":"stripe-money-v1"}'::jsonb
  );
$$;

ALTER TABLE commerce.offer
  ADD COLUMN money_unit jsonb CHECK (money_unit IS NULL OR commerce.valid_money_unit(money_unit)),
  ADD COLUMN tax_behavior text CHECK (tax_behavior IS NULL OR tax_behavior = 'exclusive');

ALTER TABLE commerce.purchase_order
  ADD COLUMN money_unit jsonb CHECK (money_unit IS NULL OR commerce.valid_money_unit(money_unit)),
  ADD COLUMN tax_behavior text CHECK (tax_behavior IS NULL OR tax_behavior = 'exclusive');

ALTER TABLE commerce.checkout_creation_attempt
  ADD COLUMN money_unit jsonb CHECK (money_unit IS NULL OR commerce.valid_money_unit(money_unit)),
  ADD COLUMN tax_behavior text CHECK (tax_behavior IS NULL OR tax_behavior = 'exclusive');

ALTER TABLE commerce.checkout_creation_attempt
  ADD COLUMN api_version text CHECK (api_version IS NULL OR api_version = '2026-09-30.endive'),
  ADD COLUMN request jsonb CHECK (request IS NULL OR (jsonb_typeof(request) = 'object' AND octet_length(request::text) <= 32768));

CREATE FUNCTION commerce.guard_captured_money() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'checkout_creation_attempt' THEN
    IF (NEW.money_unit, NEW.tax_behavior, NEW.api_version, NEW.request)
       IS DISTINCT FROM (OLD.money_unit, OLD.tax_behavior, OLD.api_version, OLD.request) THEN
      RAISE EXCEPTION 'Checkout creation money and request are immutable' USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'purchase_order' THEN
    IF (NEW.money_unit, NEW.tax_behavior) IS DISTINCT FROM (OLD.money_unit, OLD.tax_behavior) THEN
      RAISE EXCEPTION 'Captured order money is immutable' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF (NEW.money_unit, NEW.tax_behavior, NEW.unit_amount_minor)
       IS DISTINCT FROM (OLD.money_unit, OLD.tax_behavior, OLD.unit_amount_minor)
       AND (OLD.state <> 'active' OR NEW.revision <> OLD.revision + 1) THEN
      RAISE EXCEPTION 'Offer price and money adoption require an active new revision' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER offer_money_guard BEFORE UPDATE ON commerce.offer
FOR EACH ROW EXECUTE FUNCTION commerce.guard_captured_money();
CREATE TRIGGER purchase_order_money_guard BEFORE UPDATE ON commerce.purchase_order
FOR EACH ROW EXECUTE FUNCTION commerce.guard_captured_money();
CREATE TRIGGER checkout_creation_attempt_money_guard BEFORE UPDATE ON commerce.checkout_creation_attempt
FOR EACH ROW EXECUTE FUNCTION commerce.guard_captured_money();

-- migrate:down
DROP TRIGGER offer_money_guard ON commerce.offer;
DROP TRIGGER purchase_order_money_guard ON commerce.purchase_order;
DROP TRIGGER checkout_creation_attempt_money_guard ON commerce.checkout_creation_attempt;
DROP FUNCTION commerce.guard_captured_money();
ALTER TABLE commerce.checkout_creation_attempt DROP COLUMN request, DROP COLUMN api_version;
ALTER TABLE commerce.offer DROP COLUMN money_unit, DROP COLUMN tax_behavior;
ALTER TABLE commerce.purchase_order DROP COLUMN money_unit, DROP COLUMN tax_behavior;
ALTER TABLE commerce.checkout_creation_attempt DROP COLUMN money_unit, DROP COLUMN tax_behavior;
DROP FUNCTION commerce.valid_money_unit(jsonb);
