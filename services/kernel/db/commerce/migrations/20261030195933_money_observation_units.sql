-- migrate:up
-- Unit metadata is nullable for legacy rows. No raw movement economics are updated.
ALTER TABLE commerce.royalty_line ADD COLUMN money_unit jsonb;
ALTER TABLE commerce.payout_statement ADD COLUMN money_unit jsonb;

CREATE TABLE commerce.money_observation (
 route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
 order_id uuid NOT NULL,
 buyer_account_id uuid NOT NULL,
 provider_object_id text NOT NULL CHECK (provider_object_id ~ '^(cs_|txn_)[A-Za-z0-9_]{1,250}$'),
 context text NOT NULL CHECK (context IN ('checkout.integration', 'checkout.presentment', 'balance_transaction')),
 account_namespace text NOT NULL CHECK (account_namespace ~ '^[A-Za-z0-9_-]{1,64}$'),
 livemode boolean NOT NULL,
 provider_api_version text NOT NULL CHECK (char_length(provider_api_version) BETWEEN 10 AND 64),
 request_api_version text NOT NULL CHECK (char_length(request_api_version) BETWEEN 10 AND 64),
 response_api_version text,
 money_unit jsonb,
 economics_hash text NOT NULL CHECK (economics_hash ~ '^[a-f0-9]{64}$'),
 amounts jsonb NOT NULL CHECK (jsonb_typeof(amounts) = 'object'),
 observed_at timestamptz NOT NULL,
 recorded_at timestamptz NOT NULL,
 transaction_id uuid NOT NULL,
 unit_key text GENERATED ALWAYS AS (coalesce(money_unit::text, 'unknown')) STORED,
 PRIMARY KEY (route, order_id, provider_object_id, context, account_namespace, livemode, provider_api_version, unit_key, economics_hash),
 CHECK (route = (get_byte(uuid_send(order_id), 10) * 256 + get_byte(uuid_send(order_id), 11))),
 CHECK (route = (get_byte(uuid_send(buyer_account_id), 10) * 256 + get_byte(uuid_send(buyer_account_id), 11))),
 CHECK (money_unit IS NULL OR money_unit IN (
   '{"system":"stripe-api","exponent":0,"factsVersion":"stripe-money-v1"}'::jsonb,
   '{"system":"stripe-api","exponent":2,"factsVersion":"stripe-money-v1"}'::jsonb))
);
CREATE INDEX money_observation_object ON commerce.money_observation
(route, order_id, provider_object_id, context, recorded_at DESC, provider_api_version DESC, economics_hash DESC) WHERE money_unit IS NOT NULL;
CREATE INDEX money_observation_buyer ON commerce.money_observation
(route, buyer_account_id, order_id, provider_object_id, context, provider_api_version, economics_hash);
-- Appended interpretations are immutable. The financial erasure owner may delete bounded pages.
CREATE TRIGGER money_observation_guard BEFORE UPDATE ON commerce.money_observation
FOR EACH ROW EXECUTE FUNCTION commerce.guard_transaction();

CREATE OR REPLACE FUNCTION commerce.guard_payout_statement() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.state = 'paid' OR
   (NEW.route, NEW.statement_id, NEW.creator_account_id, NEW.period, NEW.currency)
   IS DISTINCT FROM (OLD.route, OLD.statement_id, OLD.creator_account_id, OLD.period, OLD.currency) THEN
   RAISE EXCEPTION 'Statement identity and paid statements are immutable' USING ERRCODE = '23514';
 END IF;
 IF NEW.money_unit IS DISTINCT FROM OLD.money_unit OR NEW.money_unit IS NULL THEN
   RAISE EXCEPTION 'Statement money interpretation unavailable' USING ERRCODE = '23514';
 END IF;
 IF NEW.state = 'paid' AND NEW.period >= to_char(NEW.paid_at AT TIME ZONE 'UTC', 'YYYY-MM') THEN
   RAISE EXCEPTION 'Only a completed UTC month can be paid' USING ERRCODE = '23514';
 END IF;
 RETURN NEW;
END;
$$;

-- migrate:down
-- Provenance observations cannot be downgraded into implicit units.
