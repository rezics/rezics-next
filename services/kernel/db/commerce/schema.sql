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
-- Name: guard_captured_money(); Type: FUNCTION; Schema: commerce; Owner: -
--

CREATE FUNCTION commerce.guard_captured_money() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: guard_content_edition(); Type: FUNCTION; Schema: commerce; Owner: -
--

CREATE FUNCTION commerce.guard_content_edition() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.content_edition IS DISTINCT FROM OLD.content_edition THEN
    RAISE EXCEPTION 'Captured Content edition is immutable, including unknown historical mapping' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: guard_creation_attempt(); Type: FUNCTION; Schema: commerce; Owner: -
--

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
-- Name: guard_live_copy_sale(); Type: FUNCTION; Schema: commerce; Owner: -
--

CREATE FUNCTION commerce.guard_live_copy_sale() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM access.live_copy_gate g
   WHERE g.route=NEW.route AND g.applying_transaction=pg_current_xact_id() AND g.outcome='applying'
     AND g.module='commerce.creator-sale' AND NOT g.retired
     AND g.payload->>'creatorAccountId'=NEW.creator_account_id::text
     AND g.payload->'view'->>'orderId'=NEW.order_id::text
     AND g.payload->'view'->>'offerId'=NEW.offer_id::text
     AND g.payload->'view'->>'targetSubjectId'=NEW.target_subject_id::text
     AND g.payload->'view'->>'title'=NEW.title AND g.payload->'view'->>'currency'=NEW.currency
     AND (g.payload->'view'->>'unitAmountMinor')::bigint=NEW.unit_amount_minor
     AND NULLIF(g.payload->'view'->'moneyUnit','null'::jsonb) IS NOT DISTINCT FROM NEW.money_unit
     AND g.payload->'view'->>'taxBehavior' IS NOT DISTINCT FROM NEW.tax_behavior
     AND g.payload->'view'->>'settlement'=NEW.settlement
     AND (g.payload->'view'->>'createdAt')::timestamptz=NEW.created_at
     AND (g.payload->>'revision')::integer=NEW.source_revision
     AND g.payload->>'transactionId'=NEW.source_transaction_id::text
     AND (g.payload->>'epoch')::bigint=NEW.source_epoch
     AND (g.payload->>'position')::bigint=NEW.source_position
     AND (g.payload->>'eventSeq')::integer=NEW.source_event_seq
     AND g.payload->>'eventId'=NEW.source_event_id::text) THEN
  RAISE EXCEPTION 'Creator sale write requires native live receiving gate' USING ERRCODE='23514';
 END IF;
 IF TG_OP='UPDATE' AND (NEW.route,NEW.creator_account_id,NEW.order_id)
    IS DISTINCT FROM (OLD.route,OLD.creator_account_id,OLD.order_id) THEN
  RAISE EXCEPTION 'Creator sale identity is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END; $$;


--
-- Name: guard_offer_target(); Type: FUNCTION; Schema: commerce; Owner: -
--

CREATE FUNCTION commerce.guard_offer_target() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF (NEW.route, NEW.offer_id, NEW.creator_account_id, NEW.target_subject_id, NEW.title, NEW.currency, NEW.tax_code, NEW.royalty_basis_points)
     IS DISTINCT FROM
     (OLD.route, OLD.offer_id, OLD.creator_account_id, OLD.target_subject_id, OLD.title, OLD.currency, OLD.tax_code, OLD.royalty_basis_points) THEN
    RAISE EXCEPTION 'Offer target and non-price terms are immutable' USING ERRCODE = '23514';
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
 IF NEW.money_unit IS DISTINCT FROM OLD.money_unit OR NEW.money_unit IS NULL THEN
   RAISE EXCEPTION 'Statement money interpretation unavailable' USING ERRCODE = '23514';
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


--
-- Name: live_copy_intent_commit(); Type: FUNCTION; Schema: commerce; Owner: -
--

CREATE FUNCTION commerce.live_copy_intent_commit() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE buyer uuid; creator uuid; intent_key jsonb; intent_kind text; buyer_state text; fenced boolean;
BEGIN
 IF NEW.order_id IS NULL THEN RETURN NULL; END IF;
 SELECT o.buyer_account_id,o.creator_account_id,a.state,a.authn_fenced INTO buyer,creator,buyer_state,fenced
   FROM commerce.purchase_order o JOIN access.account a ON (a.route,a.account_id)=(o.route,o.buyer_account_id)
   WHERE o.route=NEW.route AND o.order_id=NEW.order_id FOR UPDATE OF a FOR SHARE OF o;
 IF NOT FOUND THEN RAISE EXCEPTION 'Commerce intent requires native business roles' USING ERRCODE='23514'; END IF;
 IF buyer_state<>'active' OR fenced THEN
  RAISE EXCEPTION 'Commerce intent requires active native source account' USING ERRCODE='23514';
 END IF;
 IF TG_TABLE_NAME='creator_sale_work' THEN
  intent_kind:='commerce-work'; intent_key:=jsonb_build_object('orderId',NEW.order_id);
 ELSE
  intent_kind:='commerce-receipt'; intent_key:=jsonb_build_object('partition',NEW.partition_no,'position',NEW.position::text,'eventSeq',NEW.event_seq);
 END IF;
 IF NOT EXISTS(SELECT 1 FROM access.live_copy_business_inventory i WHERE i.route=NEW.route AND i.account_id=buyer AND i.kind=intent_kind AND i.locator=intent_key)
   OR NOT EXISTS(SELECT 1 FROM access.live_copy_business_inventory i WHERE i.route=NEW.route AND i.account_id=creator AND i.kind=intent_kind AND i.locator=intent_key) THEN
  RAISE EXCEPTION 'Commerce intent requires committed native role inventory' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END; $$;


--
-- Name: preserve_live_copy_intent(); Type: FUNCTION; Schema: commerce; Owner: -
--

CREATE FUNCTION commerce.preserve_live_copy_intent() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF TG_TABLE_NAME='creator_sale_work' THEN
  IF (NEW.route,NEW.order_id)=(OLD.route,OLD.order_id) THEN RETURN NEW; END IF;
 ELSE
  IF (NEW.partition_no,NEW.position,NEW.event_seq,NEW.epoch,NEW.event_id,NEW.route)
     =(OLD.partition_no,OLD.position,OLD.event_seq,OLD.epoch,OLD.event_id,OLD.route)
    AND ((NEW.order_id,NEW.source_revision,NEW.state) IS NOT DISTINCT FROM (OLD.order_id,OLD.source_revision,OLD.state)
      OR (NEW.order_id IS NULL AND NEW.source_revision IS NULL AND NEW.state='minimized')) THEN RETURN NEW; END IF;
 END IF;
 RAISE EXCEPTION 'Commerce live copy intent identity is immutable' USING ERRCODE='23514';
END; $$;


--
-- Name: valid_content_edition(jsonb); Type: FUNCTION; Schema: commerce; Owner: -
--

CREATE FUNCTION commerce.valid_content_edition(value jsonb) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE STRICT
    AS $_$
DECLARE
  benefit jsonb := value->'benefit';
  resource jsonb := benefit->'resource';
  version jsonb := benefit->'version';
  source jsonb := value->'source';
  native_id uuid;
BEGIN
  IF octet_length(value::text) > 4096 THEN RETURN false; END IF;
  IF NOT COALESCE(
    jsonb_typeof(value) = 'object' AND
    value - ARRAY['benefit','creatorAccountId','targetSubjectId','source','saleTermsReference','delivery','acquisition','quantity'] = '{}'::jsonb AND
    jsonb_typeof(benefit) = 'object' AND
    benefit - ARRAY['kind','resourceType','resource','version','action'] = '{}'::jsonb AND
    benefit->>'kind' = 'content-edition' AND benefit->>'resourceType' = 'content.edition' AND benefit->>'action' = 'edition:read' AND
    jsonb_typeof(resource) = 'object' AND resource - ARRAY['route','id'] = '{}'::jsonb AND
    jsonb_typeof(resource->'route') = 'number' AND resource->>'id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' AND
    jsonb_typeof(version) = 'object' AND version - ARRAY['revisionId','sha256'] = '{}'::jsonb AND
    version->>'revisionId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' AND version->>'sha256' ~ '^[a-f0-9]{64}$' AND
    value->>'creatorAccountId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' AND value->>'targetSubjectId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' AND
    jsonb_typeof(source) = 'object' AND source - ARRAY['threadId','postId','licence'] = '{}'::jsonb AND
    source->>'threadId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' AND source->>'postId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' AND
    jsonb_typeof(source->'licence') = 'string' AND char_length(source->>'licence') BETWEEN 1 AND 256 AND
    jsonb_typeof(value->'saleTermsReference') = 'string' AND char_length(value->>'saleTermsReference') BETWEEN 1 AND 256 AND
    value->>'delivery' = 'fixed-content-edition' AND value->>'acquisition' = 'one-time-account-bound' AND
    value->'quantity' = '1'::jsonb,
    false) THEN RETURN false; END IF;
  native_id := (resource->>'id')::uuid;
  RETURN (resource->>'route')::integer = get_byte(uuid_send(native_id), 10) * 256 + get_byte(uuid_send(native_id), 11)
     AND (resource->>'route')::numeric = (resource->>'route')::integer;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
  RETURN false;
END;
$_$;


--
-- Name: valid_money_unit(jsonb); Type: FUNCTION; Schema: commerce; Owner: -
--

CREATE FUNCTION commerce.valid_money_unit(value jsonb) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    AS $$
  SELECT value IN (
    '{"system":"stripe-api","exponent":0,"factsVersion":"stripe-money-v1"}'::jsonb,
    '{"system":"stripe-api","exponent":2,"factsVersion":"stripe-money-v1"}'::jsonb
  );
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: benefit_acquisition; Type: TABLE; Schema: commerce; Owner: -
--

CREATE TABLE commerce.benefit_acquisition (
    route integer NOT NULL,
    buyer_account_id uuid NOT NULL,
    benefit jsonb NOT NULL,
    slot_id uuid NOT NULL,
    order_id uuid NOT NULL,
    CONSTRAINT benefit_acquisition_benefit_check CHECK ((octet_length((benefit)::text) <= 1024)),
    CONSTRAINT benefit_acquisition_check CHECK ((route = ((get_byte(uuid_send(buyer_account_id), 10) * 256) + get_byte(uuid_send(buyer_account_id), 11)))),
    CONSTRAINT benefit_acquisition_check1 CHECK ((route = ((get_byte(uuid_send(slot_id), 10) * 256) + get_byte(uuid_send(slot_id), 11)))),
    CONSTRAINT benefit_acquisition_check2 CHECK ((route = ((get_byte(uuid_send(order_id), 10) * 256) + get_byte(uuid_send(order_id), 11)))),
    CONSTRAINT benefit_acquisition_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: checkout_creation_attempt; Type: TABLE; Schema: commerce; Owner: -
--

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
    money_unit jsonb,
    tax_behavior text,
    api_version text,
    request jsonb,
    CONSTRAINT checkout_creation_attempt_api_version_check CHECK (((api_version IS NULL) OR (api_version = ANY (ARRAY['2026-09-30.endive'::text, '2026-10-28.endive'::text])))),
    CONSTRAINT checkout_creation_attempt_cancel_check CHECK (((octet_length(cancel_url) >= 1) AND (octet_length(cancel_url) <= 8192))),
    CONSTRAINT checkout_creation_attempt_expiry_check CHECK ((expires_at > 0)),
    CONSTRAINT checkout_creation_attempt_home_check CHECK ((route = ((get_byte(uuid_send(order_id), 10) * 256) + get_byte(uuid_send(order_id), 11)))),
    CONSTRAINT checkout_creation_attempt_key_check CHECK ((provider_key = ('order:'::text || (order_id)::text))),
    CONSTRAINT checkout_creation_attempt_money_unit_check CHECK (((money_unit IS NULL) OR commerce.valid_money_unit(money_unit))),
    CONSTRAINT checkout_creation_attempt_request_check CHECK (((request IS NULL) OR ((jsonb_typeof(request) = 'object'::text) AND (octet_length((request)::text) <= 32768)))),
    CONSTRAINT checkout_creation_attempt_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT checkout_creation_attempt_success_check CHECK (((octet_length(success_url) >= 1) AND (octet_length(success_url) <= 8192))),
    CONSTRAINT checkout_creation_attempt_tax_behavior_check CHECK (((tax_behavior IS NULL) OR (tax_behavior = 'exclusive'::text)))
);


--
-- Name: creator_sale; Type: TABLE; Schema: commerce; Owner: -
--

CREATE TABLE commerce.creator_sale (
    route integer NOT NULL,
    creator_account_id uuid NOT NULL,
    order_id uuid NOT NULL,
    offer_id uuid NOT NULL,
    target_subject_id uuid NOT NULL,
    title text NOT NULL,
    currency text NOT NULL,
    unit_amount_minor bigint NOT NULL,
    money_unit jsonb,
    tax_behavior text,
    settlement text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    source_revision integer NOT NULL,
    source_transaction_id uuid NOT NULL,
    source_epoch bigint NOT NULL,
    source_position bigint NOT NULL,
    source_event_seq integer NOT NULL,
    source_event_id uuid NOT NULL,
    CONSTRAINT creator_sale_check CHECK ((route = ((get_byte(uuid_send(creator_account_id), 10) * 256) + get_byte(uuid_send(creator_account_id), 11)))),
    CONSTRAINT creator_sale_currency_check CHECK ((currency ~ '^[a-z]{3}$'::text)),
    CONSTRAINT creator_sale_money_unit_check CHECK (((money_unit IS NULL) OR (money_unit = ANY (ARRAY['{"system": "stripe-api", "exponent": 0, "factsVersion": "stripe-money-v1"}'::jsonb, '{"system": "stripe-api", "exponent": 2, "factsVersion": "stripe-money-v1"}'::jsonb])))),
    CONSTRAINT creator_sale_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT creator_sale_settlement_check CHECK ((settlement = ANY (ARRAY['pending'::text, 'paid'::text, 'failed'::text, 'unknown'::text]))),
    CONSTRAINT creator_sale_source_epoch_check CHECK ((source_epoch >= 1)),
    CONSTRAINT creator_sale_source_event_seq_check CHECK (((source_event_seq >= 0) AND (source_event_seq <= 999))),
    CONSTRAINT creator_sale_source_position_check CHECK ((source_position >= 1)),
    CONSTRAINT creator_sale_source_revision_check CHECK ((source_revision >= 1)),
    CONSTRAINT creator_sale_tax_behavior_check CHECK ((tax_behavior = 'exclusive'::text)),
    CONSTRAINT creator_sale_title_check CHECK (((char_length(title) <= 512) AND (octet_length(title) <= 2048))),
    CONSTRAINT creator_sale_unit_amount_minor_check CHECK (((unit_amount_minor >= 1) AND (unit_amount_minor <= 99999999)))
);


--
-- Name: creator_sale_receipt; Type: TABLE; Schema: commerce; Owner: -
--

CREATE TABLE commerce.creator_sale_receipt (
    partition_no integer NOT NULL,
    "position" bigint NOT NULL,
    event_seq integer NOT NULL,
    epoch bigint NOT NULL,
    event_id uuid NOT NULL,
    route integer NOT NULL,
    order_id uuid,
    source_revision integer,
    state text DEFAULT 'pending'::text NOT NULL,
    CONSTRAINT creator_sale_receipt_check CHECK ((partition_no = (route >> 4))),
    CONSTRAINT creator_sale_receipt_check1 CHECK ((route = ((get_byte(uuid_send(order_id), 10) * 256) + get_byte(uuid_send(order_id), 11)))),
    CONSTRAINT creator_sale_receipt_epoch_check CHECK ((epoch >= 1)),
    CONSTRAINT creator_sale_receipt_event_seq_check CHECK (((event_seq >= 0) AND (event_seq <= 999))),
    CONSTRAINT creator_sale_receipt_partition_no_check CHECK (((partition_no >= 0) AND (partition_no <= 4095))),
    CONSTRAINT creator_sale_receipt_position_check CHECK (("position" >= 1)),
    CONSTRAINT creator_sale_receipt_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT creator_sale_receipt_source_revision_check CHECK ((source_revision >= 1)),
    CONSTRAINT creator_sale_receipt_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'minimized'::text])))
);


--
-- Name: creator_sale_work; Type: TABLE; Schema: commerce; Owner: -
--

CREATE TABLE commerce.creator_sale_work (
    route integer NOT NULL,
    order_id uuid NOT NULL,
    generation bigint DEFAULT 1 NOT NULL,
    observed_revision integer,
    observed_transaction_id uuid,
    state text DEFAULT 'pending'::text NOT NULL,
    gap text,
    next_run timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT creator_sale_work_check CHECK ((route = ((get_byte(uuid_send(order_id), 10) * 256) + get_byte(uuid_send(order_id), 11)))),
    CONSTRAINT creator_sale_work_generation_check CHECK ((generation >= 1)),
    CONSTRAINT creator_sale_work_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT creator_sale_work_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'verified'::text])))
);


--
-- Name: creator_sales_frontier; Type: TABLE; Schema: commerce; Owner: -
--

CREATE TABLE commerce.creator_sales_frontier (
    partition_no integer NOT NULL,
    epoch bigint NOT NULL,
    after_route integer NOT NULL,
    after_order uuid DEFAULT '00000000-0000-0000-0000-000000000000'::uuid NOT NULL,
    phase text DEFAULT 'scanning'::text NOT NULL,
    next_run timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT creator_sales_frontier_check CHECK (((after_route >= (partition_no * 16)) AND (after_route <= ((partition_no * 16) + 15)))),
    CONSTRAINT creator_sales_frontier_epoch_check CHECK ((epoch >= 1)),
    CONSTRAINT creator_sales_frontier_partition_no_check CHECK (((partition_no >= 0) AND (partition_no <= 4095))),
    CONSTRAINT creator_sales_frontier_phase_check CHECK ((phase = ANY (ARRAY['scanning'::text, 'covered'::text])))
);


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
    content_edition jsonb,
    CONSTRAINT entitlement_check CHECK ((route = ((get_byte(uuid_send(entitlement_id), 10) * 256) + get_byte(uuid_send(entitlement_id), 11)))),
    CONSTRAINT entitlement_check1 CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT entitlement_check2 CHECK ((route = ((get_byte(uuid_send(order_id), 10) * 256) + get_byte(uuid_send(order_id), 11)))),
    CONSTRAINT entitlement_check3 CHECK (((revoked_at IS NULL) = (revoke_reason IS NULL))),
    CONSTRAINT entitlement_content_edition_check CHECK (((content_edition IS NULL) OR commerce.valid_content_edition(content_edition))),
    CONSTRAINT entitlement_edition_subject CHECK (((content_edition IS NULL) OR ((content_edition ->> 'targetSubjectId'::text) = (target_subject_id)::text))),
    CONSTRAINT entitlement_revision_check CHECK ((revision >= 1)),
    CONSTRAINT entitlement_revoke_reason_check CHECK ((revoke_reason = ANY (ARRAY['refund'::text, 'dispute'::text]))),
    CONSTRAINT entitlement_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: erasure_progress; Type: TABLE; Schema: commerce; Owner: -
--

CREATE TABLE commerce.erasure_progress (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    had_data boolean NOT NULL,
    cursor_id uuid DEFAULT '00000000-0000-0000-0000-000000000000'::uuid NOT NULL,
    phase text DEFAULT 'entitlements'::text NOT NULL,
    blocker text,
    CONSTRAINT erasure_progress_phase_check CHECK ((phase = ANY (ARRAY['entitlements'::text, 'pending'::text])))
);


--
-- Name: money_observation; Type: TABLE; Schema: commerce; Owner: -
--

CREATE TABLE commerce.money_observation (
    route integer NOT NULL,
    order_id uuid NOT NULL,
    buyer_account_id uuid NOT NULL,
    provider_object_id text NOT NULL,
    context text NOT NULL,
    account_namespace text NOT NULL,
    livemode boolean NOT NULL,
    provider_api_version text NOT NULL,
    request_api_version text NOT NULL,
    response_api_version text,
    money_unit jsonb,
    economics_hash text NOT NULL,
    amounts jsonb NOT NULL,
    observed_at timestamp with time zone NOT NULL,
    recorded_at timestamp with time zone NOT NULL,
    transaction_id uuid NOT NULL,
    unit_key text GENERATED ALWAYS AS (COALESCE((money_unit)::text, 'unknown'::text)) STORED NOT NULL,
    CONSTRAINT money_observation_account_namespace_check CHECK ((account_namespace ~ '^[A-Za-z0-9_-]{1,64}$'::text)),
    CONSTRAINT money_observation_amounts_check CHECK ((jsonb_typeof(amounts) = 'object'::text)),
    CONSTRAINT money_observation_check CHECK ((route = ((get_byte(uuid_send(order_id), 10) * 256) + get_byte(uuid_send(order_id), 11)))),
    CONSTRAINT money_observation_check1 CHECK ((route = ((get_byte(uuid_send(buyer_account_id), 10) * 256) + get_byte(uuid_send(buyer_account_id), 11)))),
    CONSTRAINT money_observation_context_check CHECK ((context = ANY (ARRAY['checkout.integration'::text, 'checkout.presentment'::text, 'balance_transaction'::text]))),
    CONSTRAINT money_observation_economics_hash_check CHECK ((economics_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT money_observation_money_unit_check CHECK (((money_unit IS NULL) OR (money_unit = ANY (ARRAY['{"system": "stripe-api", "exponent": 0, "factsVersion": "stripe-money-v1"}'::jsonb, '{"system": "stripe-api", "exponent": 2, "factsVersion": "stripe-money-v1"}'::jsonb])))),
    CONSTRAINT money_observation_provider_api_version_check CHECK (((char_length(provider_api_version) >= 10) AND (char_length(provider_api_version) <= 64))),
    CONSTRAINT money_observation_provider_object_id_check CHECK ((provider_object_id ~ '^(cs_|txn_)[A-Za-z0-9_]{1,250}$'::text)),
    CONSTRAINT money_observation_request_api_version_check CHECK (((char_length(request_api_version) >= 10) AND (char_length(request_api_version) <= 64))),
    CONSTRAINT money_observation_route_check CHECK (((route >= 0) AND (route <= 65535)))
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
    content_edition jsonb,
    money_unit jsonb,
    tax_behavior text,
    CONSTRAINT offer_check CHECK ((route = ((get_byte(uuid_send(offer_id), 10) * 256) + get_byte(uuid_send(offer_id), 11)))),
    CONSTRAINT offer_check1 CHECK ((route = ((get_byte(uuid_send(creator_account_id), 10) * 256) + get_byte(uuid_send(creator_account_id), 11)))),
    CONSTRAINT offer_content_edition_check CHECK (((content_edition IS NULL) OR commerce.valid_content_edition(content_edition))),
    CONSTRAINT offer_currency_check CHECK ((currency ~ '^[a-z]{3}$'::text)),
    CONSTRAINT offer_edition_creator CHECK (((content_edition IS NULL) OR ((content_edition ->> 'creatorAccountId'::text) = (creator_account_id)::text))),
    CONSTRAINT offer_edition_subject CHECK (((content_edition IS NULL) OR ((content_edition ->> 'targetSubjectId'::text) = (target_subject_id)::text))),
    CONSTRAINT offer_money_unit_check CHECK (((money_unit IS NULL) OR commerce.valid_money_unit(money_unit))),
    CONSTRAINT offer_revision_check CHECK ((revision >= 1)),
    CONSTRAINT offer_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT offer_royalty_basis_points_check CHECK (((royalty_basis_points >= 0) AND (royalty_basis_points <= 10000))),
    CONSTRAINT offer_state_check CHECK ((state = ANY (ARRAY['active'::text, 'delisted'::text]))),
    CONSTRAINT offer_tax_behavior_check CHECK (((tax_behavior IS NULL) OR (tax_behavior = 'exclusive'::text))),
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
    money_unit jsonb,
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
    content_edition jsonb,
    money_unit jsonb,
    tax_behavior text,
    acquisition_release text,
    CONSTRAINT purchase_order_acquisition_release_check CHECK ((acquisition_release = ANY (ARRAY['no-creation'::text, 'cancelled-no-charge'::text, 'refunded'::text, 'lost-dispute'::text]))),
    CONSTRAINT purchase_order_amount_tax_minor_check CHECK ((amount_tax_minor >= 0)),
    CONSTRAINT purchase_order_check CHECK ((route = ((get_byte(uuid_send(order_id), 10) * 256) + get_byte(uuid_send(order_id), 11)))),
    CONSTRAINT purchase_order_check1 CHECK ((route = ((get_byte(uuid_send(buyer_account_id), 10) * 256) + get_byte(uuid_send(buyer_account_id), 11)))),
    CONSTRAINT purchase_order_check2 CHECK ((((checkout_session_id IS NULL) AND (checkout_url IS NULL) AND (checkout_expires_at IS NULL)) OR ((checkout_session_id IS NOT NULL) AND (checkout_url IS NOT NULL) AND (checkout_expires_at IS NOT NULL)))),
    CONSTRAINT purchase_order_checkout_session_id_check CHECK ((checkout_session_id ~ '^cs_(test|live)_[A-Za-z0-9]{1,250}$'::text)),
    CONSTRAINT purchase_order_content_edition_check CHECK (((content_edition IS NULL) OR commerce.valid_content_edition(content_edition))),
    CONSTRAINT purchase_order_currency_check CHECK ((currency ~ '^[a-z]{3}$'::text)),
    CONSTRAINT purchase_order_edition_creator CHECK (((content_edition IS NULL) OR ((content_edition ->> 'creatorAccountId'::text) = (creator_account_id)::text))),
    CONSTRAINT purchase_order_edition_subject CHECK (((content_edition IS NULL) OR ((content_edition ->> 'targetSubjectId'::text) = (target_subject_id)::text))),
    CONSTRAINT purchase_order_money_unit_check CHECK (((money_unit IS NULL) OR commerce.valid_money_unit(money_unit))),
    CONSTRAINT purchase_order_offer_revision_check CHECK ((offer_revision >= 1)),
    CONSTRAINT purchase_order_payment_intent_id_check CHECK ((payment_intent_id ~ '^pi_[A-Za-z0-9]{1,250}$'::text)),
    CONSTRAINT purchase_order_revision_check CHECK ((revision >= 1)),
    CONSTRAINT purchase_order_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT purchase_order_royalty_basis_points_check CHECK (((royalty_basis_points >= 0) AND (royalty_basis_points <= 10000))),
    CONSTRAINT purchase_order_settlement_check CHECK ((settlement = ANY (ARRAY['pending'::text, 'paid'::text, 'failed'::text, 'unknown'::text]))),
    CONSTRAINT purchase_order_tax_behavior_check CHECK (((tax_behavior IS NULL) OR (tax_behavior = 'exclusive'::text))),
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
    money_unit jsonb,
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
-- Name: subject_offer_bootstrap; Type: TABLE; Schema: commerce; Owner: -
--

CREATE TABLE commerce.subject_offer_bootstrap (
    partition_no integer NOT NULL,
    frontier text NOT NULL,
    version bigint DEFAULT 1 NOT NULL,
    ready boolean DEFAULT false NOT NULL,
    CONSTRAINT subject_offer_bootstrap_partition_no_check CHECK ((partition_no = 0))
);


--
-- Name: subject_offer_reference; Type: TABLE; Schema: commerce; Owner: -
--

CREATE TABLE commerce.subject_offer_reference (
    route integer NOT NULL,
    subject_id uuid NOT NULL,
    offer_id uuid NOT NULL,
    original_subject_id uuid NOT NULL,
    source_revision integer NOT NULL,
    identity_epoch bigint NOT NULL,
    listed boolean NOT NULL,
    version bigint DEFAULT 1 NOT NULL,
    CONSTRAINT subject_offer_reference_check CHECK ((route = ((get_byte(uuid_send(subject_id), 10) * 256) + get_byte(uuid_send(subject_id), 11)))),
    CONSTRAINT subject_offer_reference_identity_epoch_check CHECK ((identity_epoch > 0)),
    CONSTRAINT subject_offer_reference_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT subject_offer_reference_source_revision_check CHECK ((source_revision > 0))
);


--
-- Name: benefit_acquisition benefit_acquisition_pkey; Type: CONSTRAINT; Schema: commerce; Owner: -
--

ALTER TABLE ONLY commerce.benefit_acquisition
    ADD CONSTRAINT benefit_acquisition_pkey PRIMARY KEY (route, buyer_account_id, benefit);


--
-- Name: checkout_creation_attempt checkout_creation_attempt_pkey; Type: CONSTRAINT; Schema: commerce; Owner: -
--

ALTER TABLE ONLY commerce.checkout_creation_attempt
    ADD CONSTRAINT checkout_creation_attempt_pkey PRIMARY KEY (route, order_id);


--
-- Name: creator_sale creator_sale_pkey; Type: CONSTRAINT; Schema: commerce; Owner: -
--

ALTER TABLE ONLY commerce.creator_sale
    ADD CONSTRAINT creator_sale_pkey PRIMARY KEY (route, creator_account_id, order_id);


--
-- Name: creator_sale_receipt creator_sale_receipt_pkey; Type: CONSTRAINT; Schema: commerce; Owner: -
--

ALTER TABLE ONLY commerce.creator_sale_receipt
    ADD CONSTRAINT creator_sale_receipt_pkey PRIMARY KEY (partition_no, "position", event_seq);


--
-- Name: creator_sale_work creator_sale_work_pkey; Type: CONSTRAINT; Schema: commerce; Owner: -
--

ALTER TABLE ONLY commerce.creator_sale_work
    ADD CONSTRAINT creator_sale_work_pkey PRIMARY KEY (route, order_id);


--
-- Name: creator_sales_frontier creator_sales_frontier_pkey; Type: CONSTRAINT; Schema: commerce; Owner: -
--

ALTER TABLE ONLY commerce.creator_sales_frontier
    ADD CONSTRAINT creator_sales_frontier_pkey PRIMARY KEY (partition_no);


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
-- Name: erasure_progress erasure_progress_pkey; Type: CONSTRAINT; Schema: commerce; Owner: -
--

ALTER TABLE ONLY commerce.erasure_progress
    ADD CONSTRAINT erasure_progress_pkey PRIMARY KEY (route, account_id);


--
-- Name: money_observation money_observation_pkey; Type: CONSTRAINT; Schema: commerce; Owner: -
--

ALTER TABLE ONLY commerce.money_observation
    ADD CONSTRAINT money_observation_pkey PRIMARY KEY (route, order_id, provider_object_id, context, account_namespace, livemode, provider_api_version, unit_key, economics_hash);


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
-- Name: subject_offer_bootstrap subject_offer_bootstrap_pkey; Type: CONSTRAINT; Schema: commerce; Owner: -
--

ALTER TABLE ONLY commerce.subject_offer_bootstrap
    ADD CONSTRAINT subject_offer_bootstrap_pkey PRIMARY KEY (partition_no);


--
-- Name: subject_offer_reference subject_offer_reference_pkey; Type: CONSTRAINT; Schema: commerce; Owner: -
--

ALTER TABLE ONLY commerce.subject_offer_reference
    ADD CONSTRAINT subject_offer_reference_pkey PRIMARY KEY (route, subject_id, offer_id);


--
-- Name: benefit_acquisition_account_page; Type: INDEX; Schema: commerce; Owner: -
--

CREATE UNIQUE INDEX benefit_acquisition_account_page ON commerce.benefit_acquisition USING btree (route, buyer_account_id, slot_id);


--
-- Name: creator_sale_receipt_event; Type: INDEX; Schema: commerce; Owner: -
--

CREATE INDEX creator_sale_receipt_event ON commerce.creator_sale_receipt USING btree (partition_no, event_id);


--
-- Name: creator_sale_receipt_order; Type: INDEX; Schema: commerce; Owner: -
--

CREATE INDEX creator_sale_receipt_order ON commerce.creator_sale_receipt USING btree (route, order_id, "position", event_seq);


--
-- Name: creator_sale_work_pending; Type: INDEX; Schema: commerce; Owner: -
--

CREATE INDEX creator_sale_work_pending ON commerce.creator_sale_work USING btree (route, next_run, order_id) WHERE (state = 'pending'::text);


--
-- Name: entitlement_account_page; Type: INDEX; Schema: commerce; Owner: -
--

CREATE INDEX entitlement_account_page ON commerce.entitlement USING btree (route, account_id, entitlement_id);


--
-- Name: entitlement_benefit_active; Type: INDEX; Schema: commerce; Owner: -
--

CREATE INDEX entitlement_benefit_active ON commerce.entitlement USING btree (route, account_id, ((content_edition -> 'benefit'::text)), entitlement_id) WHERE ((content_edition IS NOT NULL) AND (revoked_at IS NULL) AND (revoke_reason IS NULL));


--
-- Name: entitlement_edition_buyer_lookup; Type: INDEX; Schema: commerce; Owner: -
--

CREATE INDEX entitlement_edition_buyer_lookup ON commerce.entitlement USING btree (route, account_id, (((content_edition -> 'benefit'::text) ->> 'kind'::text)), (((content_edition -> 'benefit'::text) ->> 'resourceType'::text)), (((content_edition -> 'benefit'::text) ->> 'action'::text)), ((((content_edition -> 'benefit'::text) -> 'resource'::text) ->> 'route'::text)), ((((content_edition -> 'benefit'::text) -> 'resource'::text) ->> 'id'::text)), ((((content_edition -> 'benefit'::text) -> 'version'::text) ->> 'revisionId'::text)), ((((content_edition -> 'benefit'::text) -> 'version'::text) ->> 'sha256'::text)), entitlement_id) WHERE ((content_edition IS NOT NULL) AND (revoked_at IS NULL) AND (revoke_reason IS NULL));


--
-- Name: money_observation_buyer; Type: INDEX; Schema: commerce; Owner: -
--

CREATE INDEX money_observation_buyer ON commerce.money_observation USING btree (route, buyer_account_id, order_id, provider_object_id, context, provider_api_version, economics_hash);


--
-- Name: money_observation_object; Type: INDEX; Schema: commerce; Owner: -
--

CREATE INDEX money_observation_object ON commerce.money_observation USING btree (route, order_id, provider_object_id, context, recorded_at DESC, provider_api_version DESC, economics_hash DESC) WHERE (money_unit IS NOT NULL);


--
-- Name: offer_creator_page; Type: INDEX; Schema: commerce; Owner: -
--

CREATE INDEX offer_creator_page ON commerce.offer USING btree (route, creator_account_id, offer_id);


--
-- Name: offer_discovery_source; Type: INDEX; Schema: commerce; Owner: -
--

CREATE INDEX offer_discovery_source ON commerce.offer USING btree (((route >> 4)), offer_id);


--
-- Name: offer_erasure_owner; Type: INDEX; Schema: commerce; Owner: -
--

CREATE INDEX offer_erasure_owner ON commerce.offer USING btree (route, creator_account_id, offer_id);


--
-- Name: order_transaction_order; Type: INDEX; Schema: commerce; Owner: -
--

CREATE INDEX order_transaction_order ON commerce.order_transaction USING btree (route, order_id);


--
-- Name: payout_statement_creator_page; Type: INDEX; Schema: commerce; Owner: -
--

CREATE INDEX payout_statement_creator_page ON commerce.payout_statement USING btree (route, creator_account_id, statement_id);


--
-- Name: purchase_order_benefit_unresolved; Type: INDEX; Schema: commerce; Owner: -
--

CREATE INDEX purchase_order_benefit_unresolved ON commerce.purchase_order USING btree (route, buyer_account_id, ((content_edition -> 'benefit'::text)), order_id) WHERE ((content_edition IS NOT NULL) AND (acquisition_release IS NULL));


--
-- Name: purchase_order_buyer_page; Type: INDEX; Schema: commerce; Owner: -
--

CREATE INDEX purchase_order_buyer_page ON commerce.purchase_order USING btree (route, buyer_account_id, order_id);


--
-- Name: purchase_order_checkout_session; Type: INDEX; Schema: commerce; Owner: -
--

CREATE UNIQUE INDEX purchase_order_checkout_session ON commerce.purchase_order USING btree (route, checkout_session_id) WHERE (checkout_session_id IS NOT NULL);


--
-- Name: purchase_order_erasure_buyer; Type: INDEX; Schema: commerce; Owner: -
--

CREATE INDEX purchase_order_erasure_buyer ON commerce.purchase_order USING btree (route, buyer_account_id, order_id);


--
-- Name: royalty_line_erasure_creator; Type: INDEX; Schema: commerce; Owner: -
--

CREATE INDEX royalty_line_erasure_creator ON commerce.royalty_line USING btree (route, creator_account_id, balance_transaction_id);


--
-- Name: royalty_line_statement_page; Type: INDEX; Schema: commerce; Owner: -
--

CREATE INDEX royalty_line_statement_page ON commerce.royalty_line USING btree (route, statement_id, balance_transaction_id);


--
-- Name: subject_offer_original; Type: INDEX; Schema: commerce; Owner: -
--

CREATE INDEX subject_offer_original ON commerce.subject_offer_reference USING btree (route, subject_id, original_subject_id, offer_id);


--
-- Name: checkout_creation_attempt checkout_creation_attempt_guard; Type: TRIGGER; Schema: commerce; Owner: -
--

CREATE TRIGGER checkout_creation_attempt_guard BEFORE UPDATE ON commerce.checkout_creation_attempt FOR EACH ROW EXECUTE FUNCTION commerce.guard_creation_attempt();


--
-- Name: checkout_creation_attempt checkout_creation_attempt_money_guard; Type: TRIGGER; Schema: commerce; Owner: -
--

CREATE TRIGGER checkout_creation_attempt_money_guard BEFORE UPDATE ON commerce.checkout_creation_attempt FOR EACH ROW EXECUTE FUNCTION commerce.guard_captured_money();


--
-- Name: entitlement entitlement_content_edition_guard; Type: TRIGGER; Schema: commerce; Owner: -
--

CREATE TRIGGER entitlement_content_edition_guard BEFORE UPDATE ON commerce.entitlement FOR EACH ROW EXECUTE FUNCTION commerce.guard_content_edition();


--
-- Name: entitlement entitlement_guard; Type: TRIGGER; Schema: commerce; Owner: -
--

CREATE TRIGGER entitlement_guard BEFORE UPDATE ON commerce.entitlement FOR EACH ROW EXECUTE FUNCTION commerce.guard_entitlement();


--
-- Name: creator_sale_receipt live_copy_receipt_commit; Type: TRIGGER; Schema: commerce; Owner: -
--

CREATE CONSTRAINT TRIGGER live_copy_receipt_commit AFTER INSERT ON commerce.creator_sale_receipt DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION commerce.live_copy_intent_commit();


--
-- Name: creator_sale_receipt live_copy_receipt_identity; Type: TRIGGER; Schema: commerce; Owner: -
--

CREATE TRIGGER live_copy_receipt_identity BEFORE UPDATE ON commerce.creator_sale_receipt FOR EACH ROW EXECUTE FUNCTION commerce.preserve_live_copy_intent();


--
-- Name: creator_sale live_copy_sale_guard; Type: TRIGGER; Schema: commerce; Owner: -
--

CREATE TRIGGER live_copy_sale_guard BEFORE INSERT OR UPDATE ON commerce.creator_sale FOR EACH ROW EXECUTE FUNCTION commerce.guard_live_copy_sale();


--
-- Name: creator_sale_work live_copy_work_commit; Type: TRIGGER; Schema: commerce; Owner: -
--

CREATE CONSTRAINT TRIGGER live_copy_work_commit AFTER INSERT ON commerce.creator_sale_work DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION commerce.live_copy_intent_commit();


--
-- Name: creator_sale_work live_copy_work_identity; Type: TRIGGER; Schema: commerce; Owner: -
--

CREATE TRIGGER live_copy_work_identity BEFORE UPDATE ON commerce.creator_sale_work FOR EACH ROW EXECUTE FUNCTION commerce.preserve_live_copy_intent();


--
-- Name: money_observation money_observation_guard; Type: TRIGGER; Schema: commerce; Owner: -
--

CREATE TRIGGER money_observation_guard BEFORE UPDATE ON commerce.money_observation FOR EACH ROW EXECUTE FUNCTION commerce.guard_transaction();


--
-- Name: offer offer_content_edition_guard; Type: TRIGGER; Schema: commerce; Owner: -
--

CREATE TRIGGER offer_content_edition_guard BEFORE UPDATE ON commerce.offer FOR EACH ROW EXECUTE FUNCTION commerce.guard_content_edition();


--
-- Name: offer offer_money_guard; Type: TRIGGER; Schema: commerce; Owner: -
--

CREATE TRIGGER offer_money_guard BEFORE UPDATE ON commerce.offer FOR EACH ROW EXECUTE FUNCTION commerce.guard_captured_money();


--
-- Name: offer offer_target_guard; Type: TRIGGER; Schema: commerce; Owner: -
--

CREATE TRIGGER offer_target_guard BEFORE UPDATE ON commerce.offer FOR EACH ROW EXECUTE FUNCTION commerce.guard_offer_target();


--
-- Name: order_transaction order_transaction_guard; Type: TRIGGER; Schema: commerce; Owner: -
--

CREATE TRIGGER order_transaction_guard BEFORE DELETE OR UPDATE ON commerce.order_transaction FOR EACH ROW EXECUTE FUNCTION commerce.guard_transaction();


--
-- Name: payout_statement payout_statement_guard; Type: TRIGGER; Schema: commerce; Owner: -
--

CREATE TRIGGER payout_statement_guard BEFORE UPDATE ON commerce.payout_statement FOR EACH ROW EXECUTE FUNCTION commerce.guard_payout_statement();


--
-- Name: purchase_order purchase_order_content_edition_guard; Type: TRIGGER; Schema: commerce; Owner: -
--

CREATE TRIGGER purchase_order_content_edition_guard BEFORE UPDATE ON commerce.purchase_order FOR EACH ROW EXECUTE FUNCTION commerce.guard_content_edition();


--
-- Name: purchase_order purchase_order_guard; Type: TRIGGER; Schema: commerce; Owner: -
--

CREATE TRIGGER purchase_order_guard BEFORE UPDATE ON commerce.purchase_order FOR EACH ROW EXECUTE FUNCTION commerce.guard_order();


--
-- Name: purchase_order purchase_order_money_guard; Type: TRIGGER; Schema: commerce; Owner: -
--

CREATE TRIGGER purchase_order_money_guard BEFORE UPDATE ON commerce.purchase_order FOR EACH ROW EXECUTE FUNCTION commerce.guard_captured_money();


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


