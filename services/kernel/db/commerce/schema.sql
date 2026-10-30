--
-- PostgreSQL database dump
--



SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: commerce; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA commerce;


--
-- Name: guard_entitlement(); Type: FUNCTION; Schema: commerce; Owner: -
--

CREATE FUNCTION commerce.guard_entitlement() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF (NEW.route, NEW.entitlement_id, NEW.account_id, NEW.order_id, NEW.offer_id,
      NEW.target_subject_id, NEW.granted_at)
     IS DISTINCT FROM
     (OLD.route, OLD.entitlement_id, OLD.account_id, OLD.order_id, OLD.offer_id,
      OLD.target_subject_id, OLD.granted_at) THEN
    RAISE EXCEPTION 'Entitlement identity and benefit are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: guard_order(); Type: FUNCTION; Schema: commerce; Owner: -
--

CREATE FUNCTION commerce.guard_order() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF (NEW.route, NEW.order_id, NEW.buyer_account_id, NEW.offer_id, NEW.offer_revision,
      NEW.creator_account_id, NEW.title, NEW.currency, NEW.unit_amount_minor, NEW.tax_code,
      NEW.royalty_basis_points, NEW.created_at, NEW.target_subject_id)
     IS DISTINCT FROM
     (OLD.route, OLD.order_id, OLD.buyer_account_id, OLD.offer_id, OLD.offer_revision,
      OLD.creator_account_id, OLD.title, OLD.currency, OLD.unit_amount_minor, OLD.tax_code,
      OLD.royalty_basis_points, OLD.created_at, OLD.target_subject_id) THEN
    RAISE EXCEPTION 'Order identity and captured offer terms are immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.checkout_session_id IS NOT NULL AND
     (NEW.checkout_session_id, NEW.checkout_url, NEW.checkout_expires_at)
     IS DISTINCT FROM (OLD.checkout_session_id, OLD.checkout_url, OLD.checkout_expires_at) THEN
    RAISE EXCEPTION 'Recorded checkout session is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.settlement = 'paid' AND NEW.settlement <> 'paid' THEN
    RAISE EXCEPTION 'Paid settlement cannot change' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: guard_order_tax(); Type: FUNCTION; Schema: commerce; Owner: -
--

CREATE FUNCTION commerce.guard_order_tax() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.settlement = 'paid' AND NEW.amount_tax_minor IS DISTINCT FROM OLD.amount_tax_minor THEN
    RAISE EXCEPTION 'Paid Checkout tax evidence is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: guard_payout_statement(); Type: FUNCTION; Schema: commerce; Owner: -
--

CREATE FUNCTION commerce.guard_payout_statement() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.state = 'paid' OR
    (NEW.route, NEW.statement_id, NEW.creator_account_id, NEW.period, NEW.currency)
    IS DISTINCT FROM (OLD.route, OLD.statement_id, OLD.creator_account_id, OLD.period, OLD.currency) THEN
    RAISE EXCEPTION 'Statement identity and paid statements are immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.state = 'paid' AND NEW.period >= to_char(NEW.paid_at AT TIME ZONE 'UTC', 'YYYY-MM') THEN
    RAISE EXCEPTION 'Only a completed UTC month can be paid' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: guard_transaction(); Type: FUNCTION; Schema: commerce; Owner: -
--

CREATE FUNCTION commerce.guard_transaction() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'Recorded Stripe transactions are immutable' USING ERRCODE = '23514';
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: entitlement; Type: TABLE; Schema: commerce; Owner: -
--

CREATE TABLE commerce.entitlement (
    route integer NOT NULL,
    entitlement_id uuid NOT NULL,
    account_id uuid NOT NULL,
    order_id uuid NOT NULL,
    offer_id uuid NOT NULL,
    target_subject_id uuid NOT NULL,
    granted_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    revoke_reason text,
    revision integer NOT NULL,
    transaction_id uuid NOT NULL,
    CONSTRAINT entitlement_check CHECK ((route = ((get_byte(uuid_send(entitlement_id), 10) * 256) + get_byte(uuid_send(entitlement_id), 11)))),
    CONSTRAINT entitlement_check1 CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT entitlement_check2 CHECK ((route = ((get_byte(uuid_send(order_id), 10) * 256) + get_byte(uuid_send(order_id), 11)))),
    CONSTRAINT entitlement_check3 CHECK (((revoked_at IS NULL) = (revoke_reason IS NULL))),
    CONSTRAINT entitlement_revision_check CHECK ((revision >= 1)),
    CONSTRAINT entitlement_revoke_reason_check CHECK ((revoke_reason = ANY (ARRAY['refund'::text, 'dispute'::text]))),
    CONSTRAINT entitlement_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: offer; Type: TABLE; Schema: commerce; Owner: -
--

CREATE TABLE commerce.offer (
    route integer NOT NULL,
    offer_id uuid NOT NULL,
    creator_account_id uuid NOT NULL,
    target_subject_id uuid NOT NULL,
    title text NOT NULL,
    currency text NOT NULL,
    unit_amount_minor bigint NOT NULL,
    tax_code text NOT NULL,
    royalty_basis_points integer NOT NULL,
    state text NOT NULL,
    revision integer NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    transaction_id uuid NOT NULL,
    CONSTRAINT offer_check CHECK ((route = ((get_byte(uuid_send(offer_id), 10) * 256) + get_byte(uuid_send(offer_id), 11)))),
    CONSTRAINT offer_check1 CHECK ((route = ((get_byte(uuid_send(creator_account_id), 10) * 256) + get_byte(uuid_send(creator_account_id), 11)))),
    CONSTRAINT offer_currency_check CHECK ((currency ~ '^[a-z]{3}$'::text)),
    CONSTRAINT offer_revision_check CHECK ((revision >= 1)),
    CONSTRAINT offer_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT offer_royalty_basis_points_check CHECK (((royalty_basis_points >= 0) AND (royalty_basis_points <= 10000))),
    CONSTRAINT offer_state_check CHECK ((state = ANY (ARRAY['active'::text, 'delisted'::text]))),
    CONSTRAINT offer_tax_code_check CHECK ((tax_code ~ '^txcd_[0-9]{8}$'::text)),
    CONSTRAINT offer_title_check CHECK (((char_length(title) >= 1) AND (char_length(title) <= 200))),
    CONSTRAINT offer_unit_amount_minor_check CHECK (((unit_amount_minor >= 1) AND (unit_amount_minor <= 99999999)))
);


--
-- Name: order_transaction; Type: TABLE; Schema: commerce; Owner: -
--

CREATE TABLE commerce.order_transaction (
    route integer NOT NULL,
    order_id uuid NOT NULL,
    balance_transaction_id text NOT NULL,
    kind text NOT NULL,
    source_id text NOT NULL,
    currency text NOT NULL,
    amount_minor bigint NOT NULL,
    fee_minor bigint NOT NULL,
    net_minor bigint NOT NULL,
    fee_details jsonb NOT NULL,
    exchange_rate numeric,
    stripe_created timestamp with time zone NOT NULL,
    recorded_at timestamp with time zone NOT NULL,
    transaction_id uuid NOT NULL,
    CONSTRAINT order_transaction_balance_transaction_id_check CHECK ((balance_transaction_id ~ '^txn_[A-Za-z0-9]{1,250}$'::text)),
    CONSTRAINT order_transaction_check CHECK ((net_minor = (amount_minor - fee_minor))),
    CONSTRAINT order_transaction_check1 CHECK ((route = ((get_byte(uuid_send(order_id), 10) * 256) + get_byte(uuid_send(order_id), 11)))),
    CONSTRAINT order_transaction_currency_check CHECK ((currency ~ '^[a-z]{3}$'::text)),
    CONSTRAINT order_transaction_fee_details_check CHECK ((jsonb_typeof(fee_details) = 'array'::text)),
    CONSTRAINT order_transaction_kind_check CHECK ((kind = ANY (ARRAY['charge'::text, 'refund'::text, 'refund_reversal'::text, 'dispute'::text, 'dispute_reversal'::text]))),
    CONSTRAINT order_transaction_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: payout_statement; Type: TABLE; Schema: commerce; Owner: -
--

CREATE TABLE commerce.payout_statement (
    route integer NOT NULL,
    statement_id uuid NOT NULL,
    creator_account_id uuid NOT NULL,
    period text NOT NULL,
    currency text NOT NULL,
    gross_minor bigint DEFAULT 0 NOT NULL,
    tax_minor bigint DEFAULT 0 NOT NULL,
    fee_minor bigint DEFAULT 0 NOT NULL,
    dispute_fee_minor bigint DEFAULT 0 NOT NULL,
    refunds_minor bigint DEFAULT 0 NOT NULL,
    chargebacks_minor bigint DEFAULT 0 NOT NULL,
    net_receipts_minor bigint DEFAULT 0 NOT NULL,
    weighted_net_minor numeric DEFAULT 0 NOT NULL,
    state text DEFAULT 'open'::text NOT NULL,
    paid_at timestamp with time zone,
    paid_reference text,
    revision integer DEFAULT 1 NOT NULL,
    CONSTRAINT payout_statement_check CHECK ((net_receipts_minor = ((gross_minor - tax_minor) - fee_minor))),
    CONSTRAINT payout_statement_check1 CHECK ((route = ((get_byte(uuid_send(statement_id), 10) * 256) + get_byte(uuid_send(statement_id), 11)))),
    CONSTRAINT payout_statement_check2 CHECK ((route = ((get_byte(uuid_send(creator_account_id), 10) * 256) + get_byte(uuid_send(creator_account_id), 11)))),
    CONSTRAINT payout_statement_check3 CHECK ((((state = 'open'::text) AND (paid_at IS NULL) AND (paid_reference IS NULL)) OR ((state = 'paid'::text) AND (paid_at IS NOT NULL) AND (paid_reference IS NOT NULL)))),
    CONSTRAINT payout_statement_currency_check CHECK ((currency ~ '^[a-z]{3}$'::text)),
    CONSTRAINT payout_statement_paid_reference_check CHECK (((char_length(btrim(paid_reference)) >= 1) AND (char_length(btrim(paid_reference)) <= 256))),
    CONSTRAINT payout_statement_period_check CHECK ((period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'::text)),
    CONSTRAINT payout_statement_revision_check CHECK ((revision >= 1)),
    CONSTRAINT payout_statement_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT payout_statement_state_check CHECK ((state = ANY (ARRAY['open'::text, 'paid'::text]))),
    CONSTRAINT payout_statement_weighted_net_minor_check CHECK ((weighted_net_minor = trunc(weighted_net_minor)))
);


--
-- Name: purchase_order; Type: TABLE; Schema: commerce; Owner: -
--

CREATE TABLE commerce.purchase_order (
    route integer NOT NULL,
    order_id uuid NOT NULL,
    buyer_account_id uuid NOT NULL,
    offer_id uuid NOT NULL,
    offer_revision integer NOT NULL,
    creator_account_id uuid NOT NULL,
    title text NOT NULL,
    currency text NOT NULL,
    unit_amount_minor bigint NOT NULL,
    tax_code text NOT NULL,
    royalty_basis_points integer NOT NULL,
    settlement text NOT NULL,
    checkout_session_id text,
    checkout_url text,
    checkout_expires_at timestamp with time zone,
    payment_intent_id text,
    observed_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    revision integer NOT NULL,
    transaction_id uuid NOT NULL,
    amount_tax_minor bigint,
    target_subject_id uuid NOT NULL,
    CONSTRAINT purchase_order_amount_tax_minor_check CHECK ((amount_tax_minor >= 0)),
    CONSTRAINT purchase_order_check CHECK ((route = ((get_byte(uuid_send(order_id), 10) * 256) + get_byte(uuid_send(order_id), 11)))),
    CONSTRAINT purchase_order_check1 CHECK ((route = ((get_byte(uuid_send(buyer_account_id), 10) * 256) + get_byte(uuid_send(buyer_account_id), 11)))),
    CONSTRAINT purchase_order_check2 CHECK ((((checkout_session_id IS NULL) AND (checkout_url IS NULL) AND (checkout_expires_at IS NULL)) OR ((checkout_session_id IS NOT NULL) AND (checkout_url IS NOT NULL) AND (checkout_expires_at IS NOT NULL)))),
    CONSTRAINT purchase_order_checkout_session_id_check CHECK ((checkout_session_id ~ '^cs_(test|live)_[A-Za-z0-9]{1,250}$'::text)),
    CONSTRAINT purchase_order_currency_check CHECK ((currency ~ '^[a-z]{3}$'::text)),
    CONSTRAINT purchase_order_offer_revision_check CHECK ((offer_revision >= 1)),
    CONSTRAINT purchase_order_payment_intent_id_check CHECK ((payment_intent_id ~ '^pi_[A-Za-z0-9]{1,250}$'::text)),
    CONSTRAINT purchase_order_revision_check CHECK ((revision >= 1)),
    CONSTRAINT purchase_order_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT purchase_order_royalty_basis_points_check CHECK (((royalty_basis_points >= 0) AND (royalty_basis_points <= 10000))),
    CONSTRAINT purchase_order_settlement_check CHECK ((settlement = ANY (ARRAY['pending'::text, 'paid'::text, 'failed'::text, 'unknown'::text]))),
    CONSTRAINT purchase_order_tax_code_check CHECK ((tax_code ~ '^txcd_[0-9]{8}$'::text)),
    CONSTRAINT purchase_order_title_check CHECK (((char_length(title) >= 1) AND (char_length(title) <= 200))),
    CONSTRAINT purchase_order_unit_amount_minor_check CHECK (((unit_amount_minor >= 1) AND (unit_amount_minor <= 99999999)))
);


--
-- Name: royalty_line; Type: TABLE; Schema: commerce; Owner: -
--

CREATE TABLE commerce.royalty_line (
    route integer NOT NULL,
    balance_transaction_id text NOT NULL,
    creator_account_id uuid NOT NULL,
    order_id uuid NOT NULL,
    offer_id uuid NOT NULL,
    kind text NOT NULL,
    currency text NOT NULL,
    gross_minor bigint NOT NULL,
    tax_minor bigint NOT NULL,
    fee_minor bigint NOT NULL,
    dispute_fee_minor bigint NOT NULL,
    net_receipts_minor bigint NOT NULL,
    royalty_basis_points integer NOT NULL,
    period text NOT NULL,
    statement_id uuid NOT NULL,
    stripe_created timestamp with time zone DEFAULT now() NOT NULL,
    recorded_at timestamp with time zone NOT NULL,
    CONSTRAINT royalty_line_balance_transaction_id_check CHECK ((balance_transaction_id ~ '^txn_[A-Za-z0-9]{1,250}$'::text)),
    CONSTRAINT royalty_line_check CHECK ((net_receipts_minor = ((gross_minor - tax_minor) - fee_minor))),
    CONSTRAINT royalty_line_check1 CHECK ((route = ((get_byte(uuid_send(creator_account_id), 10) * 256) + get_byte(uuid_send(creator_account_id), 11)))),
    CONSTRAINT royalty_line_check2 CHECK ((route = ((get_byte(uuid_send(statement_id), 10) * 256) + get_byte(uuid_send(statement_id), 11)))),
    CONSTRAINT royalty_line_check3 CHECK ((route = ((get_byte(uuid_send(offer_id), 10) * 256) + get_byte(uuid_send(offer_id), 11)))),
    CONSTRAINT royalty_line_currency_check CHECK ((currency ~ '^[a-z]{3}$'::text)),
    CONSTRAINT royalty_line_kind_check CHECK ((kind = ANY (ARRAY['charge'::text, 'refund'::text, 'refund_reversal'::text, 'dispute'::text, 'dispute_reversal'::text]))),
    CONSTRAINT royalty_line_period_check CHECK ((period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'::text)),
    CONSTRAINT royalty_line_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT royalty_line_royalty_basis_points_check CHECK (((royalty_basis_points >= 0) AND (royalty_basis_points <= 10000)))
);


--
-- Name: entitlement entitlement_pkey; Type: CONSTRAINT; Schema: commerce; Owner: -
--

ALTER TABLE ONLY commerce.entitlement
    ADD CONSTRAINT entitlement_pkey PRIMARY KEY (route, entitlement_id);


--
-- Name: entitlement entitlement_route_order_id_key; Type: CONSTRAINT; Schema: commerce; Owner: -
--

ALTER TABLE ONLY commerce.entitlement
    ADD CONSTRAINT entitlement_route_order_id_key UNIQUE (route, order_id);


--
-- Name: offer offer_pkey; Type: CONSTRAINT; Schema: commerce; Owner: -
--

ALTER TABLE ONLY commerce.offer
    ADD CONSTRAINT offer_pkey PRIMARY KEY (route, offer_id);


--
-- Name: order_transaction order_transaction_pkey; Type: CONSTRAINT; Schema: commerce; Owner: -
--

ALTER TABLE ONLY commerce.order_transaction
    ADD CONSTRAINT order_transaction_pkey PRIMARY KEY (route, balance_transaction_id);


--
-- Name: payout_statement payout_statement_pkey; Type: CONSTRAINT; Schema: commerce; Owner: -
--

ALTER TABLE ONLY commerce.payout_statement
    ADD CONSTRAINT payout_statement_pkey PRIMARY KEY (route, statement_id);


--
-- Name: payout_statement payout_statement_route_creator_account_id_period_currency_key; Type: CONSTRAINT; Schema: commerce; Owner: -
--

ALTER TABLE ONLY commerce.payout_statement
    ADD CONSTRAINT payout_statement_route_creator_account_id_period_currency_key UNIQUE (route, creator_account_id, period, currency);


--
-- Name: purchase_order purchase_order_pkey; Type: CONSTRAINT; Schema: commerce; Owner: -
--

ALTER TABLE ONLY commerce.purchase_order
    ADD CONSTRAINT purchase_order_pkey PRIMARY KEY (route, order_id);


--
-- Name: royalty_line royalty_line_pkey; Type: CONSTRAINT; Schema: commerce; Owner: -
--

ALTER TABLE ONLY commerce.royalty_line
    ADD CONSTRAINT royalty_line_pkey PRIMARY KEY (route, balance_transaction_id);


--
-- Name: entitlement_account_page; Type: INDEX; Schema: commerce; Owner: -
--

CREATE INDEX entitlement_account_page ON commerce.entitlement USING btree (route, account_id, entitlement_id);


--
-- Name: order_transaction_order; Type: INDEX; Schema: commerce; Owner: -
--

CREATE INDEX order_transaction_order ON commerce.order_transaction USING btree (route, order_id);


--
-- Name: payout_statement_creator_page; Type: INDEX; Schema: commerce; Owner: -
--

CREATE INDEX payout_statement_creator_page ON commerce.payout_statement USING btree (route, creator_account_id, statement_id);


--
-- Name: purchase_order_buyer_page; Type: INDEX; Schema: commerce; Owner: -
--

CREATE INDEX purchase_order_buyer_page ON commerce.purchase_order USING btree (route, buyer_account_id, order_id);


--
-- Name: purchase_order_checkout_session; Type: INDEX; Schema: commerce; Owner: -
--

CREATE UNIQUE INDEX purchase_order_checkout_session ON commerce.purchase_order USING btree (route, checkout_session_id) WHERE (checkout_session_id IS NOT NULL);


--
-- Name: royalty_line_statement_page; Type: INDEX; Schema: commerce; Owner: -
--

CREATE INDEX royalty_line_statement_page ON commerce.royalty_line USING btree (route, statement_id, balance_transaction_id);


--
-- Name: entitlement entitlement_guard; Type: TRIGGER; Schema: commerce; Owner: -
--

CREATE TRIGGER entitlement_guard BEFORE UPDATE ON commerce.entitlement FOR EACH ROW EXECUTE FUNCTION commerce.guard_entitlement();


--
-- Name: order_transaction order_transaction_guard; Type: TRIGGER; Schema: commerce; Owner: -
--

CREATE TRIGGER order_transaction_guard BEFORE DELETE OR UPDATE ON commerce.order_transaction FOR EACH ROW EXECUTE FUNCTION commerce.guard_transaction();


--
-- Name: payout_statement payout_statement_guard; Type: TRIGGER; Schema: commerce; Owner: -
--

CREATE TRIGGER payout_statement_guard BEFORE UPDATE ON commerce.payout_statement FOR EACH ROW EXECUTE FUNCTION commerce.guard_payout_statement();


--
-- Name: purchase_order purchase_order_guard; Type: TRIGGER; Schema: commerce; Owner: -
--

CREATE TRIGGER purchase_order_guard BEFORE UPDATE ON commerce.purchase_order FOR EACH ROW EXECUTE FUNCTION commerce.guard_order();


--
-- Name: purchase_order purchase_order_tax_guard; Type: TRIGGER; Schema: commerce; Owner: -
--

CREATE TRIGGER purchase_order_tax_guard BEFORE UPDATE ON commerce.purchase_order FOR EACH ROW EXECUTE FUNCTION commerce.guard_order_tax();


--
-- Name: royalty_line royalty_line_guard; Type: TRIGGER; Schema: commerce; Owner: -
--

CREATE TRIGGER royalty_line_guard BEFORE DELETE OR UPDATE ON commerce.royalty_line FOR EACH ROW EXECUTE FUNCTION commerce.guard_transaction();


--
-- PostgreSQL database dump complete
--


