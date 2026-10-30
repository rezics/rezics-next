-- migrate:up
CREATE TABLE commerce.checkout_creation_attempt (
    route integer NOT NULL,
    order_id uuid NOT NULL,
    first_attempt_id uuid NOT NULL,
    first_attempt_at timestamp with time zone NOT NULL,
    provider_key text NOT NULL,
    success_url text NOT NULL,
    cancel_url text NOT NULL,
    expires_at bigint NOT NULL,
    managed_payments boolean NOT NULL,
    retried boolean DEFAULT false NOT NULL,
    CONSTRAINT checkout_creation_attempt_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT checkout_creation_attempt_home_check CHECK ((route = ((get_byte(uuid_send(order_id), 10) * 256) + get_byte(uuid_send(order_id), 11)))),
    CONSTRAINT checkout_creation_attempt_key_check CHECK ((provider_key = ('order:'::text || (order_id)::text))),
    CONSTRAINT checkout_creation_attempt_success_check CHECK (((octet_length(success_url) >= 1) AND (octet_length(success_url) <= 8192))),
    CONSTRAINT checkout_creation_attempt_cancel_check CHECK (((octet_length(cancel_url) >= 1) AND (octet_length(cancel_url) <= 8192))),
    CONSTRAINT checkout_creation_attempt_expiry_check CHECK ((expires_at > 0))
);

ALTER TABLE ONLY commerce.checkout_creation_attempt
    ADD CONSTRAINT checkout_creation_attempt_pkey PRIMARY KEY (route, order_id);

CREATE FUNCTION commerce.guard_creation_attempt() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF (NEW.route, NEW.order_id, NEW.first_attempt_id, NEW.first_attempt_at, NEW.provider_key,
      NEW.success_url, NEW.cancel_url, NEW.expires_at, NEW.managed_payments)
     IS DISTINCT FROM
     (OLD.route, OLD.order_id, OLD.first_attempt_id, OLD.first_attempt_at, OLD.provider_key,
      OLD.success_url, OLD.cancel_url, OLD.expires_at, OLD.managed_payments)
     OR (OLD.retried AND NOT NEW.retried) THEN
    RAISE EXCEPTION 'Checkout creation intent is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER checkout_creation_attempt_guard BEFORE UPDATE ON commerce.checkout_creation_attempt FOR EACH ROW EXECUTE FUNCTION commerce.guard_creation_attempt();

-- migrate:down
DROP TABLE commerce.checkout_creation_attempt;
DROP FUNCTION commerce.guard_creation_attempt();
