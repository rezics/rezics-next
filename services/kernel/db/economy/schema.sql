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
-- Name: economy; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA economy;


--
-- Name: claim_funding_posting_key(); Type: FUNCTION; Schema: economy; Owner: -
--

CREATE FUNCTION economy.claim_funding_posting_key() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
BEGIN
  INSERT INTO economy.provider_posting_key VALUES (
    NEW.provider_namespace, NEW.provider_mode, NEW.source_kind, NEW.source_id, 'wallet_funding'
  );
  RETURN NEW;
END;
$$;


--
-- Name: project_pending_deposit(); Type: FUNCTION; Schema: economy; Owner: -
--

CREATE FUNCTION economy.project_pending_deposit() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
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


--
-- Name: queue_asset_program_expiry(); Type: FUNCTION; Schema: economy; Owner: -
--

CREATE FUNCTION economy.queue_asset_program_expiry() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  INSERT INTO economy.asset_program_expiry (book_id, asset_id, expires_at)
  VALUES (NEW.book_id, NEW.asset_id, NEW.expires_at);
  RETURN NEW;
END;
$$;


--
-- Name: reject_history_edit(); Type: FUNCTION; Schema: economy; Owner: -
--

CREATE FUNCTION economy.reject_history_edit() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
BEGIN
  RAISE EXCEPTION 'Economy history and asset definitions are immutable' USING ERRCODE = '23514';
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: asset; Type: TABLE; Schema: economy; Owner: -
--

CREATE TABLE economy.asset (
    book_id text NOT NULL,
    asset_id text NOT NULL,
    scale smallint NOT NULL,
    transferable boolean NOT NULL,
    CONSTRAINT asset_asset_id_check CHECK (((char_length(asset_id) >= 1) AND (char_length(asset_id) <= 64))),
    CONSTRAINT asset_book_id_check CHECK (((char_length(book_id) >= 1) AND (char_length(book_id) <= 64))),
    CONSTRAINT asset_scale_check CHECK (((scale >= 0) AND (scale <= 18)))
);


--
-- Name: asset_program; Type: TABLE; Schema: economy; Owner: -
--

CREATE TABLE economy.asset_program (
    book_id text NOT NULL,
    asset_id text NOT NULL,
    program_id text NOT NULL,
    version bigint NOT NULL,
    issuance_source text NOT NULL,
    supply_cap bigint NOT NULL,
    redeemable boolean NOT NULL,
    expires_at timestamp with time zone,
    CONSTRAINT asset_program_issuance_source_check CHECK (((char_length(issuance_source) >= 1) AND (char_length(issuance_source) <= 64))),
    CONSTRAINT asset_program_program_id_check CHECK (((char_length(program_id) >= 1) AND (char_length(program_id) <= 64))),
    CONSTRAINT asset_program_supply_cap_check CHECK ((supply_cap > 0)),
    CONSTRAINT asset_program_version_check CHECK ((version > 0))
);


--
-- Name: asset_program_expiry; Type: TABLE; Schema: economy; Owner: -
--

CREATE TABLE economy.asset_program_expiry (
    book_id text NOT NULL,
    asset_id text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    retired_at timestamp with time zone,
    CONSTRAINT asset_program_expiry_check CHECK ((retired_at >= expires_at))
);


--
-- Name: asset_program_recipient; Type: TABLE; Schema: economy; Owner: -
--

CREATE TABLE economy.asset_program_recipient (
    book_id text NOT NULL,
    asset_id text NOT NULL,
    account_id uuid NOT NULL,
    CONSTRAINT asset_program_recipient_account_id_check CHECK ((account_id <> '00000000-0000-0000-0000-000000000000'::uuid))
);


--
-- Name: asset_program_source; Type: TABLE; Schema: economy; Owner: -
--

CREATE TABLE economy.asset_program_source (
    book_id text NOT NULL,
    asset_id text NOT NULL,
    program_id text NOT NULL,
    kind text NOT NULL,
    source_reference text NOT NULL,
    transaction_id uuid NOT NULL,
    CONSTRAINT asset_program_source_kind_check CHECK ((kind = ANY (ARRAY['mint'::text, 'redeem'::text]))),
    CONSTRAINT asset_program_source_source_reference_check CHECK (((char_length(source_reference) >= 1) AND (char_length(source_reference) <= 255)))
);


--
-- Name: command_receipt; Type: TABLE; Schema: economy; Owner: -
--

CREATE TABLE economy.command_receipt (
    book_id text NOT NULL,
    origin_id uuid NOT NULL,
    namespace text NOT NULL,
    operation_id text NOT NULL,
    digest bytea NOT NULL,
    outcome text NOT NULL,
    CONSTRAINT command_receipt_digest_check CHECK ((octet_length(digest) = 32)),
    CONSTRAINT command_receipt_namespace_check CHECK ((namespace = ANY (ARRAY['wallet'::text, 'owner'::text]))),
    CONSTRAINT command_receipt_operation_id_check CHECK (((char_length(operation_id) >= 1) AND (char_length(operation_id) <= 255))),
    CONSTRAINT command_receipt_outcome_check CHECK ((outcome = ANY (ARRAY['ok'::text, 'asset_missing'::text, 'operation_conflict'::text, 'insufficient_funds'::text, 'asset_not_transferable'::text, 'hold_missing'::text, 'hold_closed'::text, 'allocation_missing'::text, 'allocation_closed'::text, 'invalid_amount'::text, 'invalid_operation'::text, 'program_ineligible'::text, 'program_expired'::text, 'program_supply_exceeded'::text])))
);


--
-- Name: creator_payout; Type: TABLE; Schema: economy; Owner: -
--

CREATE TABLE economy.creator_payout (
    book_id text NOT NULL,
    payout_id text NOT NULL,
    creator_id uuid NOT NULL,
    asset_id text NOT NULL,
    units bigint NOT NULL,
    provider_namespace text NOT NULL,
    provider_mode text NOT NULL,
    destination_ref text NOT NULL,
    status text NOT NULL,
    paid_movement_id text,
    returned_units bigint DEFAULT 0 NOT NULL,
    reserve_transaction_id uuid NOT NULL,
    CONSTRAINT creator_payout_check CHECK (((returned_units >= 0) AND (returned_units <= units))),
    CONSTRAINT creator_payout_check1 CHECK (((status = 'paid'::text) = (paid_movement_id IS NOT NULL))),
    CONSTRAINT creator_payout_check2 CHECK (((status = 'paid'::text) OR (returned_units = 0))),
    CONSTRAINT creator_payout_creator_id_check CHECK ((creator_id <> '00000000-0000-0000-0000-000000000000'::uuid)),
    CONSTRAINT creator_payout_destination_ref_check CHECK (((char_length(destination_ref) >= 1) AND (char_length(destination_ref) <= 255))),
    CONSTRAINT creator_payout_paid_movement_id_check CHECK (((char_length(paid_movement_id) >= 1) AND (char_length(paid_movement_id) <= 255))),
    CONSTRAINT creator_payout_payout_id_check CHECK (((char_length(payout_id) >= 1) AND (char_length(payout_id) <= 64))),
    CONSTRAINT creator_payout_provider_mode_check CHECK ((provider_mode = ANY (ARRAY['test'::text, 'live'::text]))),
    CONSTRAINT creator_payout_provider_namespace_check CHECK (((char_length(provider_namespace) >= 1) AND (char_length(provider_namespace) <= 255))),
    CONSTRAINT creator_payout_status_check CHECK ((status = ANY (ARRAY['reserved'::text, 'paid'::text, 'released'::text]))),
    CONSTRAINT creator_payout_units_check CHECK ((units > 0))
);


--
-- Name: creator_posting; Type: TABLE; Schema: economy; Owner: -
--

CREATE TABLE economy.creator_posting (
    source_namespace text NOT NULL,
    source_mode text NOT NULL,
    source_kind text NOT NULL,
    source_id text NOT NULL,
    book_id text NOT NULL,
    asset_id text NOT NULL,
    payout_id text,
    digest bytea NOT NULL,
    transaction_id uuid NOT NULL,
    CONSTRAINT creator_posting_check CHECK (((source_kind = 'accrual'::text) = (source_mode = 'owner'::text))),
    CONSTRAINT creator_posting_check1 CHECK (((source_kind = 'accrual'::text) = (payout_id IS NULL))),
    CONSTRAINT creator_posting_digest_check CHECK ((octet_length(digest) = 32)),
    CONSTRAINT creator_posting_source_id_check CHECK (((char_length(source_id) >= 1) AND (char_length(source_id) <= 255))),
    CONSTRAINT creator_posting_source_kind_check CHECK ((source_kind = ANY (ARRAY['accrual'::text, 'movement'::text, 'refusal'::text]))),
    CONSTRAINT creator_posting_source_mode_check CHECK ((source_mode = ANY (ARRAY['owner'::text, 'test'::text, 'live'::text]))),
    CONSTRAINT creator_posting_source_namespace_check CHECK (((char_length(source_namespace) >= 1) AND (char_length(source_namespace) <= 255)))
);


--
-- Name: entry; Type: TABLE; Schema: economy; Owner: -
--

CREATE TABLE economy.entry (
    book_id text NOT NULL,
    asset_id text NOT NULL,
    account_id uuid NOT NULL,
    "position" bigint NOT NULL,
    transaction_id uuid NOT NULL,
    posted_delta bigint NOT NULL,
    held_delta bigint NOT NULL,
    CONSTRAINT entry_check CHECK (((posted_delta <> 0) OR (held_delta <> 0))),
    CONSTRAINT entry_position_check CHECK (("position" > 0))
);


--
-- Name: funding_control_account; Type: TABLE; Schema: economy; Owner: -
--

CREATE TABLE economy.funding_control_account (
    book_id text NOT NULL,
    asset_id text NOT NULL,
    account_role text NOT NULL,
    reference text NOT NULL,
    account_id uuid NOT NULL,
    CONSTRAINT funding_control_account_account_id_check CHECK ((account_id <> '00000000-0000-0000-0000-000000000000'::uuid)),
    CONSTRAINT funding_control_account_account_role_check CHECK ((account_role = ANY (ARRAY['provider_clearing'::text, 'chargeback_receivable'::text, 'creator_expense'::text, 'creator_payable'::text]))),
    CONSTRAINT funding_control_account_reference_check CHECK (((char_length(reference) >= 1) AND (char_length(reference) <= 263)))
);


--
-- Name: funding_dispatch; Type: TABLE; Schema: economy; Owner: -
--

CREATE TABLE economy.funding_dispatch (
    book_id text NOT NULL,
    intent_id text NOT NULL,
    attempt_id text NOT NULL,
    action text NOT NULL,
    due_at timestamp with time zone DEFAULT statement_timestamp() NOT NULL,
    active_claim_id uuid,
    closed_at timestamp with time zone,
    test_lane text,
    CONSTRAINT funding_dispatch_action_check CHECK ((action = ANY (ARRAY['submit'::text, 'reconcile'::text]))),
    CONSTRAINT funding_dispatch_test_lane_check CHECK ((test_lane ~ '^[0-9a-f]{64}$'::text))
);


--
-- Name: funding_dispatch_claim; Type: TABLE; Schema: economy; Owner: -
--

CREATE TABLE economy.funding_dispatch_claim (
    book_id text NOT NULL,
    intent_id text NOT NULL,
    claim_id uuid NOT NULL,
    action text NOT NULL,
    lease_until timestamp with time zone NOT NULL,
    acknowledgment text,
    CONSTRAINT funding_dispatch_claim_acknowledgment_check CHECK (((char_length(acknowledgment) >= 1) AND (char_length(acknowledgment) <= 4096))),
    CONSTRAINT funding_dispatch_claim_action_check CHECK ((action = ANY (ARRAY['submit'::text, 'reconcile'::text])))
);


--
-- Name: funding_evidence; Type: TABLE; Schema: economy; Owner: -
--

CREATE TABLE economy.funding_evidence (
    provider_namespace text NOT NULL,
    provider_mode text NOT NULL,
    source_kind text NOT NULL,
    source_id text NOT NULL,
    book_id text NOT NULL,
    intent_id text NOT NULL,
    fingerprint text NOT NULL,
    recorded_at timestamp with time zone DEFAULT statement_timestamp() NOT NULL,
    CONSTRAINT funding_evidence_fingerprint_check CHECK (((char_length(fingerprint) >= 1) AND (char_length(fingerprint) <= 4096))),
    CONSTRAINT funding_evidence_source_id_check CHECK (((char_length(source_id) >= 1) AND (char_length(source_id) <= 255))),
    CONSTRAINT funding_evidence_source_kind_check CHECK ((source_kind = ANY (ARRAY['movement'::text, 'refusal'::text])))
);


--
-- Name: funding_intent; Type: TABLE; Schema: economy; Owner: -
--

CREATE TABLE economy.funding_intent (
    book_id text NOT NULL,
    intent_id text NOT NULL,
    wallet_id uuid NOT NULL,
    asset_id text NOT NULL,
    units bigint NOT NULL,
    direction text NOT NULL,
    provider_namespace text NOT NULL,
    provider_mode text NOT NULL,
    destination_ref text NOT NULL,
    phase text NOT NULL,
    confirmed_movement_id text,
    reversed_units bigint NOT NULL,
    CONSTRAINT funding_intent_check CHECK (((reversed_units >= 0) AND (reversed_units <= units))),
    CONSTRAINT funding_intent_check1 CHECK (((phase <> 'awaiting_hold'::text) OR (direction = 'withdrawal'::text))),
    CONSTRAINT funding_intent_check2 CHECK (((phase = ANY (ARRAY['confirmed'::text, 'reversed'::text])) = (confirmed_movement_id IS NOT NULL))),
    CONSTRAINT funding_intent_check3 CHECK (((confirmed_movement_id IS NOT NULL) OR (reversed_units = 0))),
    CONSTRAINT funding_intent_check4 CHECK (((phase = 'reversed'::text) = (reversed_units = units))),
    CONSTRAINT funding_intent_confirmed_movement_id_check CHECK (((char_length(confirmed_movement_id) >= 1) AND (char_length(confirmed_movement_id) <= 255))),
    CONSTRAINT funding_intent_destination_ref_check CHECK (((char_length(destination_ref) >= 1) AND (char_length(destination_ref) <= 255))),
    CONSTRAINT funding_intent_direction_check CHECK ((direction = ANY (ARRAY['deposit'::text, 'withdrawal'::text]))),
    CONSTRAINT funding_intent_intent_id_check CHECK ((intent_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'::text)),
    CONSTRAINT funding_intent_phase_check CHECK ((phase = ANY (ARRAY['awaiting_hold'::text, 'ready'::text, 'submitted'::text, 'unknown'::text, 'refused'::text, 'confirmed'::text, 'reversed'::text]))),
    CONSTRAINT funding_intent_provider_mode_check CHECK ((provider_mode = ANY (ARRAY['test'::text, 'live'::text]))),
    CONSTRAINT funding_intent_provider_namespace_check CHECK (((char_length(provider_namespace) >= 1) AND (char_length(provider_namespace) <= 255))),
    CONSTRAINT funding_intent_units_check CHECK ((units > 0)),
    CONSTRAINT funding_intent_wallet_id_check CHECK ((wallet_id <> '00000000-0000-0000-0000-000000000000'::uuid))
);


--
-- Name: funding_posting; Type: TABLE; Schema: economy; Owner: -
--

CREATE TABLE economy.funding_posting (
    provider_namespace text NOT NULL,
    provider_mode text NOT NULL,
    source_kind text NOT NULL,
    source_id text NOT NULL,
    book_id text NOT NULL,
    asset_id text NOT NULL,
    transaction_id uuid NOT NULL
);


--
-- Name: hold; Type: TABLE; Schema: economy; Owner: -
--

CREATE TABLE economy.hold (
    book_id text NOT NULL,
    asset_id text NOT NULL,
    account_id uuid NOT NULL,
    hold_id text NOT NULL,
    reserve_transaction_id uuid NOT NULL,
    original bigint NOT NULL,
    remaining bigint NOT NULL,
    captured bigint DEFAULT 0 NOT NULL,
    released bigint DEFAULT 0 NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    closed_at timestamp with time zone,
    allocated bigint DEFAULT 0 NOT NULL,
    CONSTRAINT hold_account_id_check CHECK ((account_id <> '00000000-0000-0000-0000-000000000000'::uuid)),
    CONSTRAINT hold_captured_check CHECK ((captured >= 0)),
    CONSTRAINT hold_check CHECK (((original)::numeric = (((remaining)::numeric + (captured)::numeric) + (released)::numeric))),
    CONSTRAINT hold_check1 CHECK (((remaining = 0) = (closed_at IS NOT NULL))),
    CONSTRAINT hold_check2 CHECK (((allocated >= 0) AND (allocated <= remaining))),
    CONSTRAINT hold_hold_id_check CHECK (((char_length(hold_id) >= 1) AND (char_length(hold_id) <= 255))),
    CONSTRAINT hold_original_check CHECK ((original > 0)),
    CONSTRAINT hold_released_check CHECK ((released >= 0)),
    CONSTRAINT hold_remaining_check CHECK ((remaining >= 0))
);


--
-- Name: hold_allocation; Type: TABLE; Schema: economy; Owner: -
--

CREATE TABLE economy.hold_allocation (
    book_id text NOT NULL,
    asset_id text NOT NULL,
    account_id uuid NOT NULL,
    hold_id text NOT NULL,
    purpose text NOT NULL,
    reference text NOT NULL,
    amount bigint NOT NULL,
    status text NOT NULL,
    recipient_id uuid,
    allocation_transaction_id uuid NOT NULL,
    allocated_at timestamp with time zone NOT NULL,
    terminal_transaction_id uuid,
    resolved_at timestamp with time zone,
    CONSTRAINT hold_allocation_amount_check CHECK ((amount > 0)),
    CONSTRAINT hold_allocation_check CHECK (((status = 'captured'::text) = (recipient_id IS NOT NULL))),
    CONSTRAINT hold_allocation_check1 CHECK (((status = 'protected'::text) = (terminal_transaction_id IS NULL))),
    CONSTRAINT hold_allocation_check2 CHECK (((terminal_transaction_id IS NULL) = (resolved_at IS NULL))),
    CONSTRAINT hold_allocation_purpose_check CHECK ((purpose = ANY (ARRAY['spot_fill'::text, 'market_trade'::text, 'withdrawal'::text]))),
    CONSTRAINT hold_allocation_reference_check CHECK (((char_length(reference) >= 1) AND (char_length(reference) <= 255))),
    CONSTRAINT hold_allocation_status_check CHECK ((status = ANY (ARRAY['protected'::text, 'captured'::text, 'released'::text])))
);


--
-- Name: journal; Type: TABLE; Schema: economy; Owner: -
--

CREATE TABLE economy.journal (
    book_id text NOT NULL,
    origin_id uuid NOT NULL,
    namespace text NOT NULL,
    operation_id text NOT NULL,
    asset_id text NOT NULL,
    transaction_id uuid NOT NULL,
    kind text NOT NULL,
    hold_id text,
    recorded_at timestamp with time zone NOT NULL,
    CONSTRAINT journal_hold_kind_check CHECK (((kind = ANY (ARRAY['reserve'::text, 'capture'::text, 'release'::text, 'expire'::text, 'release_amount'::text, 'allocate'::text, 'capture_allocation'::text, 'release_allocation'::text, 'withdrawal'::text, 'withdrawal_refusal'::text])) = (hold_id IS NOT NULL))),
    CONSTRAINT journal_kind_check CHECK ((kind = ANY (ARRAY['issue'::text, 'transfer'::text, 'reserve'::text, 'capture'::text, 'release'::text, 'expire'::text, 'release_amount'::text, 'allocate'::text, 'capture_allocation'::text, 'release_allocation'::text, 'deposit'::text, 'withdrawal'::text, 'withdrawal_return'::text, 'chargeback'::text, 'withdrawal_refusal'::text, 'creator_accrual'::text, 'creator_payout_reserve'::text, 'creator_payout'::text, 'creator_payout_refusal'::text, 'creator_payout_return'::text, 'redeem'::text, 'credit_expiry'::text]))),
    CONSTRAINT journal_wallet_kind_check CHECK (((kind = ANY (ARRAY['transfer'::text, 'redeem'::text])) = (namespace = 'wallet'::text)))
);


--
-- Name: market_funds_receipt; Type: TABLE; Schema: economy; Owner: -
--

CREATE TABLE economy.market_funds_receipt (
    book_id text NOT NULL,
    instruction_id text NOT NULL,
    trade_id text NOT NULL,
    work jsonb NOT NULL,
    receipt_id uuid NOT NULL,
    CONSTRAINT market_funds_receipt_work_check CHECK ((jsonb_typeof(work) = 'object'::text))
);


--
-- Name: market_funds_trade; Type: TABLE; Schema: economy; Owner: -
--

CREATE TABLE economy.market_funds_trade (
    book_id text NOT NULL,
    trade_id text NOT NULL,
    binding jsonb NOT NULL,
    escrow_id uuid NOT NULL,
    funded boolean NOT NULL,
    phase text NOT NULL,
    decided_at bigint,
    CONSTRAINT market_funds_trade_binding_check CHECK ((jsonb_typeof(binding) = 'object'::text)),
    CONSTRAINT market_funds_trade_check CHECK (((phase = 'prepared'::text) = (decided_at IS NULL))),
    CONSTRAINT market_funds_trade_check1 CHECK ((funded OR (phase = ANY (ARRAY['fenced'::text, 'released'::text])))),
    CONSTRAINT market_funds_trade_decided_at_check CHECK ((decided_at >= 0)),
    CONSTRAINT market_funds_trade_phase_check CHECK ((phase = ANY (ARRAY['prepared'::text, 'fenced'::text, 'released'::text, 'escrowed'::text, 'settled'::text])))
);


--
-- Name: market_item; Type: TABLE; Schema: economy; Owner: -
--

CREATE TABLE economy.market_item (
    home_id text NOT NULL,
    item_id text NOT NULL,
    initial_holder_id text NOT NULL,
    holder_id text NOT NULL,
    generation bigint DEFAULT 1 NOT NULL,
    marketable boolean NOT NULL,
    CONSTRAINT market_item_generation_check CHECK ((generation > 0))
);


--
-- Name: market_item_listing; Type: TABLE; Schema: economy; Owner: -
--

CREATE TABLE economy.market_item_listing (
    home_id text NOT NULL,
    book_id text NOT NULL,
    listing_id text NOT NULL,
    item_id text NOT NULL,
    holder_id text NOT NULL,
    generation bigint NOT NULL,
    reservation_id text NOT NULL,
    protected_until bigint NOT NULL,
    phase text NOT NULL,
    trade_id text,
    CONSTRAINT market_item_listing_check CHECK (((phase <> 'reserved'::text) OR (trade_id IS NULL))),
    CONSTRAINT market_item_listing_check1 CHECK (((phase <> ALL (ARRAY['prepared'::text, 'fenced'::text, 'delivered'::text])) OR (trade_id IS NOT NULL))),
    CONSTRAINT market_item_listing_generation_check CHECK ((generation > 0)),
    CONSTRAINT market_item_listing_phase_check CHECK ((phase = ANY (ARRAY['reserved'::text, 'prepared'::text, 'fenced'::text, 'released'::text, 'delivered'::text]))),
    CONSTRAINT market_item_listing_protected_until_check CHECK ((protected_until > 0))
);


--
-- Name: market_item_receipt; Type: TABLE; Schema: economy; Owner: -
--

CREATE TABLE economy.market_item_receipt (
    home_id text NOT NULL,
    book_id text NOT NULL,
    instruction_id text NOT NULL,
    work jsonb NOT NULL,
    receipt_id uuid NOT NULL,
    observed_generation bigint,
    CONSTRAINT market_item_receipt_observed_generation_check CHECK ((observed_generation > 0)),
    CONSTRAINT market_item_receipt_work_check CHECK ((jsonb_typeof(work) = 'object'::text))
);


--
-- Name: market_item_trade; Type: TABLE; Schema: economy; Owner: -
--

CREATE TABLE economy.market_item_trade (
    home_id text NOT NULL,
    book_id text NOT NULL,
    trade_id text NOT NULL,
    listing_id text NOT NULL,
    binding jsonb NOT NULL,
    phase text NOT NULL,
    decided_at bigint,
    CONSTRAINT market_item_trade_binding_check CHECK ((jsonb_typeof(binding) = 'object'::text)),
    CONSTRAINT market_item_trade_check CHECK (((phase = 'prepared'::text) = (decided_at IS NULL))),
    CONSTRAINT market_item_trade_decided_at_check CHECK ((decided_at >= 0)),
    CONSTRAINT market_item_trade_phase_check CHECK ((phase = ANY (ARRAY['prepared'::text, 'fenced'::text, 'released'::text, 'delivered'::text])))
);


--
-- Name: market_listing; Type: TABLE; Schema: economy; Owner: -
--

CREATE TABLE economy.market_listing (
    book_id text NOT NULL,
    listing_id text NOT NULL,
    item_home_id text NOT NULL,
    item_id text NOT NULL,
    reservation_id text NOT NULL,
    revision bigint NOT NULL,
    payload jsonb NOT NULL,
    CONSTRAINT market_listing_payload_check CHECK ((jsonb_typeof(payload) = 'object'::text)),
    CONSTRAINT market_listing_revision_check CHECK ((revision >= 0))
);


--
-- Name: market_trade; Type: TABLE; Schema: economy; Owner: -
--

CREATE TABLE economy.market_trade (
    book_id text NOT NULL,
    trade_id text NOT NULL,
    listing_id text NOT NULL,
    revision bigint NOT NULL,
    prepare_until bigint NOT NULL,
    payload jsonb NOT NULL,
    decision_pending boolean GENERATED ALWAYS AS (((payload -> 'decision'::text) = 'null'::jsonb)) STORED NOT NULL,
    prepared boolean GENERATED ALWAYS AS (((payload -> 'receipts'::text) ?& ARRAY['prepare_item'::text, 'prepare_funds'::text])) STORED NOT NULL,
    CONSTRAINT market_trade_payload_check CHECK ((jsonb_typeof(payload) = 'object'::text)),
    CONSTRAINT market_trade_prepare_until_check CHECK ((prepare_until > 0)),
    CONSTRAINT market_trade_revision_check CHECK ((revision >= 0))
);


--
-- Name: market_work; Type: TABLE; Schema: economy; Owner: -
--

CREATE TABLE economy.market_work (
    book_id text NOT NULL,
    instruction_id text NOT NULL,
    listing_id text NOT NULL,
    trade_id text,
    owner_kind text NOT NULL,
    owner_id text NOT NULL,
    payload jsonb NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    claim_id uuid,
    available_at timestamp with time zone DEFAULT statement_timestamp() NOT NULL,
    receipt jsonb,
    CONSTRAINT market_work_check CHECK (((status = 'acknowledged'::text) = (receipt IS NOT NULL))),
    CONSTRAINT market_work_check1 CHECK (((status <> 'acknowledged'::text) OR (claim_id IS NOT NULL))),
    CONSTRAINT market_work_owner_kind_check CHECK ((owner_kind = ANY (ARRAY['item'::text, 'ledger'::text]))),
    CONSTRAINT market_work_payload_check CHECK ((jsonb_typeof(payload) = 'object'::text)),
    CONSTRAINT market_work_receipt_check CHECK (((receipt IS NULL) OR (jsonb_typeof(receipt) = 'object'::text))),
    CONSTRAINT market_work_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'acknowledged'::text, 'superseded'::text])))
);


--
-- Name: pending_deposit; Type: TABLE; Schema: economy; Owner: -
--

CREATE TABLE economy.pending_deposit (
    book_id text NOT NULL,
    asset_id text NOT NULL,
    wallet_id uuid NOT NULL,
    units numeric(39,0) NOT NULL,
    CONSTRAINT pending_deposit_units_check CHECK ((units >= (0)::numeric))
);


--
-- Name: position; Type: TABLE; Schema: economy; Owner: -
--

CREATE TABLE economy."position" (
    book_id text NOT NULL,
    asset_id text NOT NULL,
    account_id uuid NOT NULL,
    posted bigint DEFAULT 0 NOT NULL,
    held bigint DEFAULT 0 NOT NULL,
    restricted bigint DEFAULT 0 NOT NULL,
    revision bigint DEFAULT 0 NOT NULL,
    account_role text DEFAULT 'wallet'::text NOT NULL,
    CONSTRAINT position_account_role_check CHECK ((account_role = ANY (ARRAY['wallet'::text, 'issuer'::text, 'provider_clearing'::text, 'chargeback_receivable'::text, 'creator_expense'::text, 'creator_payable'::text]))),
    CONSTRAINT position_balance_by_role_check CHECK ((((account_role = 'wallet'::text) AND ((posted)::numeric >= ((held)::numeric + (restricted)::numeric))) OR ((account_role = 'creator_payable'::text) AND (posted >= held) AND (restricted = 0)) OR ((account_role <> ALL (ARRAY['wallet'::text, 'creator_payable'::text])) AND (held = 0) AND (restricted = 0)))),
    CONSTRAINT position_check CHECK (((held >= 0) AND (restricted >= 0))),
    CONSTRAINT position_issuer_role_check CHECK (((account_role = 'issuer'::text) = (account_id = '00000000-0000-0000-0000-000000000000'::uuid))),
    CONSTRAINT position_revision_check CHECK ((revision >= 0))
);


--
-- Name: provider_posting_key; Type: TABLE; Schema: economy; Owner: -
--

CREATE TABLE economy.provider_posting_key (
    provider_namespace text NOT NULL,
    provider_mode text NOT NULL,
    source_kind text NOT NULL,
    source_id text NOT NULL,
    owner text NOT NULL,
    CONSTRAINT provider_posting_key_owner_check CHECK ((owner = ANY (ARRAY['wallet_funding'::text, 'creator_payout'::text]))),
    CONSTRAINT provider_posting_key_provider_mode_check CHECK ((provider_mode = ANY (ARRAY['test'::text, 'live'::text]))),
    CONSTRAINT provider_posting_key_source_kind_check CHECK ((source_kind = ANY (ARRAY['movement'::text, 'refusal'::text])))
);


--
-- Name: spot_fill; Type: TABLE; Schema: economy; Owner: -
--

CREATE TABLE economy.spot_fill (
    book_id text NOT NULL,
    fill_id text NOT NULL,
    instrument_id text NOT NULL,
    maker_order_id text NOT NULL,
    taker_order_id text NOT NULL,
    buyer_id uuid NOT NULL,
    seller_id uuid NOT NULL,
    buyer_hold_id uuid NOT NULL,
    seller_hold_id uuid NOT NULL,
    lots bigint NOT NULL,
    price bigint NOT NULL,
    base_units bigint NOT NULL,
    quote_units bigint NOT NULL,
    buyer_fee_units bigint NOT NULL,
    seller_fee_units bigint NOT NULL,
    due_at timestamp with time zone DEFAULT statement_timestamp() NOT NULL,
    claim_id uuid,
    settled_at timestamp with time zone,
    CONSTRAINT spot_fill_base_units_check CHECK ((base_units > 0)),
    CONSTRAINT spot_fill_buyer_fee_units_check CHECK ((buyer_fee_units >= 0)),
    CONSTRAINT spot_fill_check CHECK (((seller_fee_units >= 0) AND (seller_fee_units <= quote_units))),
    CONSTRAINT spot_fill_check1 CHECK (((maker_order_id <> taker_order_id) AND (buyer_id <> seller_id))),
    CONSTRAINT spot_fill_check2 CHECK ((((quote_units)::numeric + (buyer_fee_units)::numeric) <= ('9223372036854775807'::bigint)::numeric)),
    CONSTRAINT spot_fill_check3 CHECK (((settled_at IS NULL) OR (claim_id IS NOT NULL))),
    CONSTRAINT spot_fill_fill_id_check CHECK (((length(fill_id) >= 1) AND (length(fill_id) <= 255))),
    CONSTRAINT spot_fill_lots_check CHECK ((lots > 0)),
    CONSTRAINT spot_fill_price_check CHECK ((price > 0)),
    CONSTRAINT spot_fill_quote_units_check CHECK ((quote_units > 0))
);


--
-- Name: spot_instrument; Type: TABLE; Schema: economy; Owner: -
--

CREATE TABLE economy.spot_instrument (
    book_id text NOT NULL,
    instrument_id text NOT NULL,
    policy_version bigint NOT NULL,
    base_asset_id text NOT NULL,
    quote_asset_id text NOT NULL,
    base_units_per_lot bigint NOT NULL,
    quote_units_per_price_tick bigint NOT NULL,
    maker_fee_bps bigint NOT NULL,
    taker_fee_bps bigint NOT NULL,
    fee_account_id uuid NOT NULL,
    revision bigint DEFAULT 0 NOT NULL,
    matching_sequence bigint,
    CONSTRAINT spot_instrument_base_units_per_lot_check CHECK ((base_units_per_lot > 0)),
    CONSTRAINT spot_instrument_check CHECK (((matching_sequence > 0) AND (matching_sequence <= revision))),
    CONSTRAINT spot_instrument_check1 CHECK ((base_asset_id <> quote_asset_id)),
    CONSTRAINT spot_instrument_fee_account_id_check CHECK ((fee_account_id <> '00000000-0000-0000-0000-000000000000'::uuid)),
    CONSTRAINT spot_instrument_instrument_id_check CHECK ((instrument_id ~ '^[a-zA-Z0-9_-]{1,64}$'::text)),
    CONSTRAINT spot_instrument_maker_fee_bps_check CHECK (((maker_fee_bps >= 0) AND (maker_fee_bps <= 10000))),
    CONSTRAINT spot_instrument_policy_version_check CHECK ((policy_version > 0)),
    CONSTRAINT spot_instrument_quote_units_per_price_tick_check CHECK ((quote_units_per_price_tick > 0)),
    CONSTRAINT spot_instrument_revision_check CHECK ((revision >= 0)),
    CONSTRAINT spot_instrument_taker_fee_bps_check CHECK (((taker_fee_bps >= 0) AND (taker_fee_bps <= 10000)))
);


--
-- Name: spot_match_step; Type: TABLE; Schema: economy; Owner: -
--

CREATE TABLE economy.spot_match_step (
    book_id text NOT NULL,
    instrument_id text NOT NULL,
    from_revision bigint NOT NULL,
    order_id text NOT NULL,
    status text NOT NULL,
    fill_ids text[] NOT NULL,
    CONSTRAINT spot_match_step_fill_ids_check CHECK ((cardinality(fill_ids) <= 32)),
    CONSTRAINT spot_match_step_from_revision_check CHECK ((from_revision > 0)),
    CONSTRAINT spot_match_step_status_check CHECK ((status = ANY (ARRAY['matching'::text, 'resting'::text, 'filled'::text, 'cancelled'::text])))
);


--
-- Name: spot_order; Type: TABLE; Schema: economy; Owner: -
--

CREATE TABLE economy.spot_order (
    book_id text NOT NULL,
    instrument_id text NOT NULL,
    order_id text NOT NULL,
    account_id uuid NOT NULL,
    sequence bigint NOT NULL,
    side text NOT NULL,
    price bigint NOT NULL,
    lots bigint NOT NULL,
    remaining_lots bigint NOT NULL,
    status text NOT NULL,
    reservation_id uuid NOT NULL,
    reserved_units_per_lot bigint NOT NULL,
    CONSTRAINT spot_order_check CHECK (((remaining_lots >= 0) AND (remaining_lots <= lots))),
    CONSTRAINT spot_order_check1 CHECK (((status = 'filled'::text) = (remaining_lots = 0))),
    CONSTRAINT spot_order_lots_check CHECK ((lots > 0)),
    CONSTRAINT spot_order_order_id_check CHECK ((order_id ~ '^[a-zA-Z0-9_-]{1,64}$'::text)),
    CONSTRAINT spot_order_price_check CHECK ((price > 0)),
    CONSTRAINT spot_order_reserved_units_per_lot_check CHECK ((reserved_units_per_lot > 0)),
    CONSTRAINT spot_order_sequence_check CHECK ((sequence > 0)),
    CONSTRAINT spot_order_side_check CHECK ((side = ANY (ARRAY['buy'::text, 'sell'::text]))),
    CONSTRAINT spot_order_status_check CHECK ((status = ANY (ARRAY['matching'::text, 'resting'::text, 'filled'::text, 'cancelled'::text])))
);


--
-- Name: spot_settlement; Type: TABLE; Schema: economy; Owner: -
--

CREATE TABLE economy.spot_settlement (
    book_id text NOT NULL,
    fill_id text NOT NULL,
    digest bytea NOT NULL,
    base_asset_id text NOT NULL,
    base_transaction_id uuid NOT NULL,
    quote_asset_id text NOT NULL,
    quote_transaction_id uuid NOT NULL,
    CONSTRAINT spot_settlement_check CHECK ((base_asset_id <> quote_asset_id)),
    CONSTRAINT spot_settlement_digest_check CHECK ((octet_length(digest) = 32)),
    CONSTRAINT spot_settlement_fill_id_check CHECK (((char_length(fill_id) >= 1) AND (char_length(fill_id) <= 255)))
);


--
-- Name: asset asset_pkey; Type: CONSTRAINT; Schema: economy; Owner: -
--

ALTER TABLE ONLY economy.asset
    ADD CONSTRAINT asset_pkey PRIMARY KEY (book_id, asset_id);


--
-- Name: asset_program asset_program_book_id_asset_id_program_id_key; Type: CONSTRAINT; Schema: economy; Owner: -
--

ALTER TABLE ONLY economy.asset_program
    ADD CONSTRAINT asset_program_book_id_asset_id_program_id_key UNIQUE (book_id, asset_id, program_id);


--
-- Name: asset_program asset_program_book_id_program_id_version_key; Type: CONSTRAINT; Schema: economy; Owner: -
--

ALTER TABLE ONLY economy.asset_program
    ADD CONSTRAINT asset_program_book_id_program_id_version_key UNIQUE (book_id, program_id, version);


--
-- Name: asset_program_expiry asset_program_expiry_pkey; Type: CONSTRAINT; Schema: economy; Owner: -
--

ALTER TABLE ONLY economy.asset_program_expiry
    ADD CONSTRAINT asset_program_expiry_pkey PRIMARY KEY (book_id, asset_id);


--
-- Name: asset_program asset_program_pkey; Type: CONSTRAINT; Schema: economy; Owner: -
--

ALTER TABLE ONLY economy.asset_program
    ADD CONSTRAINT asset_program_pkey PRIMARY KEY (book_id, asset_id);


--
-- Name: asset_program_recipient asset_program_recipient_pkey; Type: CONSTRAINT; Schema: economy; Owner: -
--

ALTER TABLE ONLY economy.asset_program_recipient
    ADD CONSTRAINT asset_program_recipient_pkey PRIMARY KEY (book_id, asset_id, account_id);


--
-- Name: asset_program_source asset_program_source_book_id_asset_id_transaction_id_key; Type: CONSTRAINT; Schema: economy; Owner: -
--

ALTER TABLE ONLY economy.asset_program_source
    ADD CONSTRAINT asset_program_source_book_id_asset_id_transaction_id_key UNIQUE (book_id, asset_id, transaction_id);


--
-- Name: asset_program_source asset_program_source_pkey; Type: CONSTRAINT; Schema: economy; Owner: -
--

ALTER TABLE ONLY economy.asset_program_source
    ADD CONSTRAINT asset_program_source_pkey PRIMARY KEY (book_id, program_id, kind, source_reference);


--
-- Name: command_receipt command_receipt_pkey; Type: CONSTRAINT; Schema: economy; Owner: -
--

ALTER TABLE ONLY economy.command_receipt
    ADD CONSTRAINT command_receipt_pkey PRIMARY KEY (book_id, origin_id, namespace, operation_id);


--
-- Name: creator_payout creator_payout_book_id_asset_id_reserve_transaction_id_key; Type: CONSTRAINT; Schema: economy; Owner: -
--

ALTER TABLE ONLY economy.creator_payout
    ADD CONSTRAINT creator_payout_book_id_asset_id_reserve_transaction_id_key UNIQUE (book_id, asset_id, reserve_transaction_id);


--
-- Name: creator_payout creator_payout_pkey; Type: CONSTRAINT; Schema: economy; Owner: -
--

ALTER TABLE ONLY economy.creator_payout
    ADD CONSTRAINT creator_payout_pkey PRIMARY KEY (book_id, payout_id);


--
-- Name: creator_posting creator_posting_book_id_asset_id_transaction_id_key; Type: CONSTRAINT; Schema: economy; Owner: -
--

ALTER TABLE ONLY economy.creator_posting
    ADD CONSTRAINT creator_posting_book_id_asset_id_transaction_id_key UNIQUE (book_id, asset_id, transaction_id);


--
-- Name: creator_posting creator_posting_pkey; Type: CONSTRAINT; Schema: economy; Owner: -
--

ALTER TABLE ONLY economy.creator_posting
    ADD CONSTRAINT creator_posting_pkey PRIMARY KEY (source_namespace, source_mode, source_kind, source_id);


--
-- Name: entry entry_book_id_asset_id_transaction_id_account_id_key; Type: CONSTRAINT; Schema: economy; Owner: -
--

ALTER TABLE ONLY economy.entry
    ADD CONSTRAINT entry_book_id_asset_id_transaction_id_account_id_key UNIQUE (book_id, asset_id, transaction_id, account_id);


--
-- Name: entry entry_pkey; Type: CONSTRAINT; Schema: economy; Owner: -
--

ALTER TABLE ONLY economy.entry
    ADD CONSTRAINT entry_pkey PRIMARY KEY (book_id, asset_id, account_id, "position");


--
-- Name: funding_control_account funding_control_account_book_id_asset_id_account_id_key; Type: CONSTRAINT; Schema: economy; Owner: -
--

ALTER TABLE ONLY economy.funding_control_account
    ADD CONSTRAINT funding_control_account_book_id_asset_id_account_id_key UNIQUE (book_id, asset_id, account_id);


--
-- Name: funding_control_account funding_control_account_pkey; Type: CONSTRAINT; Schema: economy; Owner: -
--

ALTER TABLE ONLY economy.funding_control_account
    ADD CONSTRAINT funding_control_account_pkey PRIMARY KEY (book_id, asset_id, account_role, reference);


--
-- Name: funding_dispatch funding_dispatch_attempt_id_key; Type: CONSTRAINT; Schema: economy; Owner: -
--

ALTER TABLE ONLY economy.funding_dispatch
    ADD CONSTRAINT funding_dispatch_attempt_id_key UNIQUE (attempt_id);


--
-- Name: funding_dispatch_claim funding_dispatch_claim_pkey; Type: CONSTRAINT; Schema: economy; Owner: -
--

ALTER TABLE ONLY economy.funding_dispatch_claim
    ADD CONSTRAINT funding_dispatch_claim_pkey PRIMARY KEY (book_id, intent_id, claim_id);


--
-- Name: funding_dispatch funding_dispatch_pkey; Type: CONSTRAINT; Schema: economy; Owner: -
--

ALTER TABLE ONLY economy.funding_dispatch
    ADD CONSTRAINT funding_dispatch_pkey PRIMARY KEY (book_id, intent_id);


--
-- Name: funding_evidence funding_evidence_pkey; Type: CONSTRAINT; Schema: economy; Owner: -
--

ALTER TABLE ONLY economy.funding_evidence
    ADD CONSTRAINT funding_evidence_pkey PRIMARY KEY (provider_namespace, provider_mode, source_kind, source_id);


--
-- Name: funding_intent funding_intent_book_id_intent_id_provider_namespace_provide_key; Type: CONSTRAINT; Schema: economy; Owner: -
--

ALTER TABLE ONLY economy.funding_intent
    ADD CONSTRAINT funding_intent_book_id_intent_id_provider_namespace_provide_key UNIQUE (book_id, intent_id, provider_namespace, provider_mode);


--
-- Name: funding_intent funding_intent_pkey; Type: CONSTRAINT; Schema: economy; Owner: -
--

ALTER TABLE ONLY economy.funding_intent
    ADD CONSTRAINT funding_intent_pkey PRIMARY KEY (book_id, intent_id);


--
-- Name: funding_posting funding_posting_book_id_asset_id_transaction_id_key; Type: CONSTRAINT; Schema: economy; Owner: -
--

ALTER TABLE ONLY economy.funding_posting
    ADD CONSTRAINT funding_posting_book_id_asset_id_transaction_id_key UNIQUE (book_id, asset_id, transaction_id);


--
-- Name: funding_posting funding_posting_pkey; Type: CONSTRAINT; Schema: economy; Owner: -
--

ALTER TABLE ONLY economy.funding_posting
    ADD CONSTRAINT funding_posting_pkey PRIMARY KEY (provider_namespace, provider_mode, source_kind, source_id);


--
-- Name: hold_allocation hold_allocation_book_id_asset_id_allocation_transaction_id_key; Type: CONSTRAINT; Schema: economy; Owner: -
--

ALTER TABLE ONLY economy.hold_allocation
    ADD CONSTRAINT hold_allocation_book_id_asset_id_allocation_transaction_id_key UNIQUE (book_id, asset_id, allocation_transaction_id);


--
-- Name: hold_allocation hold_allocation_book_id_asset_id_terminal_transaction_id_key; Type: CONSTRAINT; Schema: economy; Owner: -
--

ALTER TABLE ONLY economy.hold_allocation
    ADD CONSTRAINT hold_allocation_book_id_asset_id_terminal_transaction_id_key UNIQUE (book_id, asset_id, terminal_transaction_id);


--
-- Name: hold_allocation hold_allocation_pkey; Type: CONSTRAINT; Schema: economy; Owner: -
--

ALTER TABLE ONLY economy.hold_allocation
    ADD CONSTRAINT hold_allocation_pkey PRIMARY KEY (book_id, asset_id, account_id, hold_id, purpose, reference);


--
-- Name: hold hold_pkey; Type: CONSTRAINT; Schema: economy; Owner: -
--

ALTER TABLE ONLY economy.hold
    ADD CONSTRAINT hold_pkey PRIMARY KEY (book_id, asset_id, account_id, hold_id);


--
-- Name: journal journal_book_id_origin_id_namespace_operation_id_key; Type: CONSTRAINT; Schema: economy; Owner: -
--

ALTER TABLE ONLY economy.journal
    ADD CONSTRAINT journal_book_id_origin_id_namespace_operation_id_key UNIQUE (book_id, origin_id, namespace, operation_id);


--
-- Name: journal journal_pkey; Type: CONSTRAINT; Schema: economy; Owner: -
--

ALTER TABLE ONLY economy.journal
    ADD CONSTRAINT journal_pkey PRIMARY KEY (book_id, asset_id, transaction_id);


--
-- Name: market_funds_receipt market_funds_receipt_pkey; Type: CONSTRAINT; Schema: economy; Owner: -
--

ALTER TABLE ONLY economy.market_funds_receipt
    ADD CONSTRAINT market_funds_receipt_pkey PRIMARY KEY (book_id, instruction_id);


--
-- Name: market_funds_trade market_funds_trade_book_id_escrow_id_key; Type: CONSTRAINT; Schema: economy; Owner: -
--

ALTER TABLE ONLY economy.market_funds_trade
    ADD CONSTRAINT market_funds_trade_book_id_escrow_id_key UNIQUE (book_id, escrow_id);


--
-- Name: market_funds_trade market_funds_trade_pkey; Type: CONSTRAINT; Schema: economy; Owner: -
--

ALTER TABLE ONLY economy.market_funds_trade
    ADD CONSTRAINT market_funds_trade_pkey PRIMARY KEY (book_id, trade_id);


--
-- Name: market_item_listing market_item_listing_home_id_item_id_reservation_id_key; Type: CONSTRAINT; Schema: economy; Owner: -
--

ALTER TABLE ONLY economy.market_item_listing
    ADD CONSTRAINT market_item_listing_home_id_item_id_reservation_id_key UNIQUE (home_id, item_id, reservation_id);


--
-- Name: market_item_listing market_item_listing_pkey; Type: CONSTRAINT; Schema: economy; Owner: -
--

ALTER TABLE ONLY economy.market_item_listing
    ADD CONSTRAINT market_item_listing_pkey PRIMARY KEY (home_id, book_id, listing_id);


--
-- Name: market_item market_item_pkey; Type: CONSTRAINT; Schema: economy; Owner: -
--

ALTER TABLE ONLY economy.market_item
    ADD CONSTRAINT market_item_pkey PRIMARY KEY (home_id, item_id);


--
-- Name: market_item_receipt market_item_receipt_pkey; Type: CONSTRAINT; Schema: economy; Owner: -
--

ALTER TABLE ONLY economy.market_item_receipt
    ADD CONSTRAINT market_item_receipt_pkey PRIMARY KEY (home_id, book_id, instruction_id);


--
-- Name: market_item_trade market_item_trade_pkey; Type: CONSTRAINT; Schema: economy; Owner: -
--

ALTER TABLE ONLY economy.market_item_trade
    ADD CONSTRAINT market_item_trade_pkey PRIMARY KEY (home_id, book_id, trade_id);


--
-- Name: market_listing market_listing_book_id_item_home_id_item_id_reservation_id_key; Type: CONSTRAINT; Schema: economy; Owner: -
--

ALTER TABLE ONLY economy.market_listing
    ADD CONSTRAINT market_listing_book_id_item_home_id_item_id_reservation_id_key UNIQUE (book_id, item_home_id, item_id, reservation_id);


--
-- Name: market_listing market_listing_pkey; Type: CONSTRAINT; Schema: economy; Owner: -
--

ALTER TABLE ONLY economy.market_listing
    ADD CONSTRAINT market_listing_pkey PRIMARY KEY (book_id, listing_id);


--
-- Name: market_trade market_trade_book_id_listing_id_key; Type: CONSTRAINT; Schema: economy; Owner: -
--

ALTER TABLE ONLY economy.market_trade
    ADD CONSTRAINT market_trade_book_id_listing_id_key UNIQUE (book_id, listing_id);


--
-- Name: market_trade market_trade_pkey; Type: CONSTRAINT; Schema: economy; Owner: -
--

ALTER TABLE ONLY economy.market_trade
    ADD CONSTRAINT market_trade_pkey PRIMARY KEY (book_id, trade_id);


--
-- Name: market_work market_work_pkey; Type: CONSTRAINT; Schema: economy; Owner: -
--

ALTER TABLE ONLY economy.market_work
    ADD CONSTRAINT market_work_pkey PRIMARY KEY (book_id, instruction_id);


--
-- Name: pending_deposit pending_deposit_pkey; Type: CONSTRAINT; Schema: economy; Owner: -
--

ALTER TABLE ONLY economy.pending_deposit
    ADD CONSTRAINT pending_deposit_pkey PRIMARY KEY (book_id, asset_id, wallet_id);


--
-- Name: position position_pkey; Type: CONSTRAINT; Schema: economy; Owner: -
--

ALTER TABLE ONLY economy."position"
    ADD CONSTRAINT position_pkey PRIMARY KEY (book_id, asset_id, account_id);


--
-- Name: provider_posting_key provider_posting_key_pkey; Type: CONSTRAINT; Schema: economy; Owner: -
--

ALTER TABLE ONLY economy.provider_posting_key
    ADD CONSTRAINT provider_posting_key_pkey PRIMARY KEY (provider_namespace, provider_mode, source_kind, source_id);


--
-- Name: spot_fill spot_fill_pkey; Type: CONSTRAINT; Schema: economy; Owner: -
--

ALTER TABLE ONLY economy.spot_fill
    ADD CONSTRAINT spot_fill_pkey PRIMARY KEY (book_id, fill_id);


--
-- Name: spot_instrument spot_instrument_pkey; Type: CONSTRAINT; Schema: economy; Owner: -
--

ALTER TABLE ONLY economy.spot_instrument
    ADD CONSTRAINT spot_instrument_pkey PRIMARY KEY (book_id, instrument_id);


--
-- Name: spot_match_step spot_match_step_pkey; Type: CONSTRAINT; Schema: economy; Owner: -
--

ALTER TABLE ONLY economy.spot_match_step
    ADD CONSTRAINT spot_match_step_pkey PRIMARY KEY (book_id, instrument_id, from_revision);


--
-- Name: spot_order spot_order_book_id_instrument_id_sequence_key; Type: CONSTRAINT; Schema: economy; Owner: -
--

ALTER TABLE ONLY economy.spot_order
    ADD CONSTRAINT spot_order_book_id_instrument_id_sequence_key UNIQUE (book_id, instrument_id, sequence);


--
-- Name: spot_order spot_order_pkey; Type: CONSTRAINT; Schema: economy; Owner: -
--

ALTER TABLE ONLY economy.spot_order
    ADD CONSTRAINT spot_order_pkey PRIMARY KEY (book_id, instrument_id, order_id);


--
-- Name: spot_settlement spot_settlement_pkey; Type: CONSTRAINT; Schema: economy; Owner: -
--

ALTER TABLE ONLY economy.spot_settlement
    ADD CONSTRAINT spot_settlement_pkey PRIMARY KEY (book_id, fill_id);


--
-- Name: asset_program_expiry_ready_idx; Type: INDEX; Schema: economy; Owner: -
--

CREATE INDEX asset_program_expiry_ready_idx ON economy.asset_program_expiry USING btree (book_id, expires_at, asset_id) WHERE (retired_at IS NULL);


--
-- Name: funding_dispatch_due_idx; Type: INDEX; Schema: economy; Owner: -
--

CREATE INDEX funding_dispatch_due_idx ON economy.funding_dispatch USING btree (book_id, due_at, intent_id) WHERE (closed_at IS NULL);


--
-- Name: funding_dispatch_test_due_idx; Type: INDEX; Schema: economy; Owner: -
--

CREATE INDEX funding_dispatch_test_due_idx ON economy.funding_dispatch USING btree (book_id, test_lane, due_at, intent_id) WHERE ((closed_at IS NULL) AND (test_lane IS NOT NULL));


--
-- Name: hold_due_idx; Type: INDEX; Schema: economy; Owner: -
--

CREATE INDEX hold_due_idx ON economy.hold USING btree (book_id, expires_at, asset_id, account_id, hold_id) WHERE (remaining > allocated);


--
-- Name: market_one_active_item_listing; Type: INDEX; Schema: economy; Owner: -
--

CREATE UNIQUE INDEX market_one_active_item_listing ON economy.market_item_listing USING btree (home_id, item_id) WHERE (phase = ANY (ARRAY['reserved'::text, 'prepared'::text, 'fenced'::text]));


--
-- Name: market_trade_pending_decision; Type: INDEX; Schema: economy; Owner: -
--

CREATE INDEX market_trade_pending_decision ON economy.market_trade USING btree (book_id, prepare_until, trade_id) WHERE decision_pending;


--
-- Name: market_trade_prepared_decision; Type: INDEX; Schema: economy; Owner: -
--

CREATE INDEX market_trade_prepared_decision ON economy.market_trade USING btree (book_id, prepare_until, trade_id) WHERE (decision_pending AND prepared);


--
-- Name: market_work_by_trade; Type: INDEX; Schema: economy; Owner: -
--

CREATE INDEX market_work_by_trade ON economy.market_work USING btree (book_id, trade_id);


--
-- Name: market_work_ready; Type: INDEX; Schema: economy; Owner: -
--

CREATE INDEX market_work_ready ON economy.market_work USING btree (book_id, owner_kind, owner_id, available_at, instruction_id) WHERE (status = 'pending'::text);


--
-- Name: pending_deposit_wallet_asset_page; Type: INDEX; Schema: economy; Owner: -
--

CREATE INDEX pending_deposit_wallet_asset_page ON economy.pending_deposit USING btree (book_id, wallet_id, asset_id) WHERE (units > (0)::numeric);


--
-- Name: position_expirable_credit_idx; Type: INDEX; Schema: economy; Owner: -
--

CREATE INDEX position_expirable_credit_idx ON economy."position" USING btree (book_id, asset_id, account_id) WHERE ((account_role = 'wallet'::text) AND (posted > 0));


--
-- Name: position_wallet_asset_page; Type: INDEX; Schema: economy; Owner: -
--

CREATE INDEX position_wallet_asset_page ON economy."position" USING btree (book_id, account_id, asset_id) WHERE (account_role = 'wallet'::text);


--
-- Name: spot_ask_priority; Type: INDEX; Schema: economy; Owner: -
--

CREATE INDEX spot_ask_priority ON economy.spot_order USING btree (book_id, instrument_id, price, sequence) WHERE ((status = 'resting'::text) AND (side = 'sell'::text));


--
-- Name: spot_bid_priority; Type: INDEX; Schema: economy; Owner: -
--

CREATE INDEX spot_bid_priority ON economy.spot_order USING btree (book_id, instrument_id, price DESC, sequence) WHERE ((status = 'resting'::text) AND (side = 'buy'::text));


--
-- Name: spot_fill_ready; Type: INDEX; Schema: economy; Owner: -
--

CREATE INDEX spot_fill_ready ON economy.spot_fill USING btree (book_id, due_at, fill_id) WHERE (settled_at IS NULL);


--
-- Name: spot_fill_settled_feed; Type: INDEX; Schema: economy; Owner: -
--

CREATE INDEX spot_fill_settled_feed ON economy.spot_fill USING btree (book_id, instrument_id, settled_at DESC, fill_id DESC) WHERE (settled_at IS NOT NULL);


--
-- Name: spot_matching_ready; Type: INDEX; Schema: economy; Owner: -
--

CREATE INDEX spot_matching_ready ON economy.spot_instrument USING btree (book_id, instrument_id) WHERE (matching_sequence IS NOT NULL);


--
-- Name: spot_one_matching_order; Type: INDEX; Schema: economy; Owner: -
--

CREATE UNIQUE INDEX spot_one_matching_order ON economy.spot_order USING btree (book_id, instrument_id) WHERE (status = 'matching'::text);


--
-- Name: asset asset_immutable; Type: TRIGGER; Schema: economy; Owner: -
--

CREATE TRIGGER asset_immutable BEFORE DELETE OR UPDATE ON economy.asset FOR EACH ROW EXECUTE FUNCTION economy.reject_history_edit();


--
-- Name: asset_program asset_program_enqueue_expiry; Type: TRIGGER; Schema: economy; Owner: -
--

CREATE TRIGGER asset_program_enqueue_expiry AFTER INSERT ON economy.asset_program FOR EACH ROW WHEN ((new.expires_at IS NOT NULL)) EXECUTE FUNCTION economy.queue_asset_program_expiry();


--
-- Name: asset_program asset_program_immutable; Type: TRIGGER; Schema: economy; Owner: -
--

CREATE TRIGGER asset_program_immutable BEFORE DELETE OR UPDATE ON economy.asset_program FOR EACH ROW EXECUTE FUNCTION economy.reject_history_edit();


--
-- Name: asset_program_source asset_program_source_immutable; Type: TRIGGER; Schema: economy; Owner: -
--

CREATE TRIGGER asset_program_source_immutable BEFORE DELETE OR UPDATE ON economy.asset_program_source FOR EACH ROW EXECUTE FUNCTION economy.reject_history_edit();


--
-- Name: creator_posting creator_posting_immutable; Type: TRIGGER; Schema: economy; Owner: -
--

CREATE TRIGGER creator_posting_immutable BEFORE DELETE OR UPDATE ON economy.creator_posting FOR EACH ROW EXECUTE FUNCTION economy.reject_history_edit();


--
-- Name: entry entry_immutable; Type: TRIGGER; Schema: economy; Owner: -
--

CREATE TRIGGER entry_immutable BEFORE DELETE OR UPDATE ON economy.entry FOR EACH ROW EXECUTE FUNCTION economy.reject_history_edit();


--
-- Name: funding_control_account funding_control_account_immutable; Type: TRIGGER; Schema: economy; Owner: -
--

CREATE TRIGGER funding_control_account_immutable BEFORE DELETE OR UPDATE ON economy.funding_control_account FOR EACH ROW EXECUTE FUNCTION economy.reject_history_edit();


--
-- Name: funding_evidence funding_evidence_immutable; Type: TRIGGER; Schema: economy; Owner: -
--

CREATE TRIGGER funding_evidence_immutable BEFORE DELETE OR UPDATE ON economy.funding_evidence FOR EACH ROW EXECUTE FUNCTION economy.reject_history_edit();


--
-- Name: funding_intent funding_intent_pending_deposit; Type: TRIGGER; Schema: economy; Owner: -
--

CREATE TRIGGER funding_intent_pending_deposit AFTER INSERT OR UPDATE OF phase ON economy.funding_intent FOR EACH ROW EXECUTE FUNCTION economy.project_pending_deposit();


--
-- Name: funding_posting funding_posting_evidence_identity; Type: TRIGGER; Schema: economy; Owner: -
--

CREATE TRIGGER funding_posting_evidence_identity BEFORE INSERT ON economy.funding_posting FOR EACH ROW EXECUTE FUNCTION economy.claim_funding_posting_key();


--
-- Name: funding_posting funding_posting_immutable; Type: TRIGGER; Schema: economy; Owner: -
--

CREATE TRIGGER funding_posting_immutable BEFORE DELETE OR UPDATE ON economy.funding_posting FOR EACH ROW EXECUTE FUNCTION economy.reject_history_edit();


--
-- Name: journal journal_immutable; Type: TRIGGER; Schema: economy; Owner: -
--

CREATE TRIGGER journal_immutable BEFORE DELETE OR UPDATE ON economy.journal FOR EACH ROW EXECUTE FUNCTION economy.reject_history_edit();


--
-- Name: market_funds_receipt market_funds_receipt_immutable; Type: TRIGGER; Schema: economy; Owner: -
--

CREATE TRIGGER market_funds_receipt_immutable BEFORE DELETE OR UPDATE ON economy.market_funds_receipt FOR EACH ROW EXECUTE FUNCTION economy.reject_history_edit();


--
-- Name: market_item_receipt market_item_receipt_immutable; Type: TRIGGER; Schema: economy; Owner: -
--

CREATE TRIGGER market_item_receipt_immutable BEFORE DELETE OR UPDATE ON economy.market_item_receipt FOR EACH ROW EXECUTE FUNCTION economy.reject_history_edit();


--
-- Name: provider_posting_key provider_posting_key_immutable; Type: TRIGGER; Schema: economy; Owner: -
--

CREATE TRIGGER provider_posting_key_immutable BEFORE DELETE OR UPDATE ON economy.provider_posting_key FOR EACH ROW EXECUTE FUNCTION economy.reject_history_edit();


--
-- Name: command_receipt receipt_immutable; Type: TRIGGER; Schema: economy; Owner: -
--

CREATE TRIGGER receipt_immutable BEFORE DELETE OR UPDATE ON economy.command_receipt FOR EACH ROW EXECUTE FUNCTION economy.reject_history_edit();


--
-- Name: spot_fill spot_fill_terms_immutable; Type: TRIGGER; Schema: economy; Owner: -
--

CREATE TRIGGER spot_fill_terms_immutable BEFORE DELETE OR UPDATE OF book_id, fill_id, instrument_id, maker_order_id, taker_order_id, buyer_id, seller_id, buyer_hold_id, seller_hold_id, lots, price, base_units, quote_units, buyer_fee_units, seller_fee_units ON economy.spot_fill FOR EACH ROW EXECUTE FUNCTION economy.reject_history_edit();


--
-- Name: spot_instrument spot_instrument_terms_immutable; Type: TRIGGER; Schema: economy; Owner: -
--

CREATE TRIGGER spot_instrument_terms_immutable BEFORE DELETE OR UPDATE OF book_id, instrument_id, policy_version, base_asset_id, quote_asset_id, base_units_per_lot, quote_units_per_price_tick, maker_fee_bps, taker_fee_bps, fee_account_id ON economy.spot_instrument FOR EACH ROW EXECUTE FUNCTION economy.reject_history_edit();


--
-- Name: spot_match_step spot_match_step_immutable; Type: TRIGGER; Schema: economy; Owner: -
--

CREATE TRIGGER spot_match_step_immutable BEFORE DELETE OR UPDATE ON economy.spot_match_step FOR EACH ROW EXECUTE FUNCTION economy.reject_history_edit();


--
-- Name: spot_order spot_order_terms_immutable; Type: TRIGGER; Schema: economy; Owner: -
--

CREATE TRIGGER spot_order_terms_immutable BEFORE DELETE OR UPDATE OF book_id, instrument_id, order_id, account_id, sequence, side, price, lots, reservation_id, reserved_units_per_lot ON economy.spot_order FOR EACH ROW EXECUTE FUNCTION economy.reject_history_edit();


--
-- Name: spot_settlement spot_settlement_immutable; Type: TRIGGER; Schema: economy; Owner: -
--

CREATE TRIGGER spot_settlement_immutable BEFORE DELETE OR UPDATE ON economy.spot_settlement FOR EACH ROW EXECUTE FUNCTION economy.reject_history_edit();


--
-- Name: asset_program asset_program_book_id_asset_id_fkey; Type: FK CONSTRAINT; Schema: economy; Owner: -
--

ALTER TABLE ONLY economy.asset_program
    ADD CONSTRAINT asset_program_book_id_asset_id_fkey FOREIGN KEY (book_id, asset_id) REFERENCES economy.asset(book_id, asset_id);


--
-- Name: asset_program_expiry asset_program_expiry_book_id_asset_id_fkey; Type: FK CONSTRAINT; Schema: economy; Owner: -
--

ALTER TABLE ONLY economy.asset_program_expiry
    ADD CONSTRAINT asset_program_expiry_book_id_asset_id_fkey FOREIGN KEY (book_id, asset_id) REFERENCES economy.asset_program(book_id, asset_id);


--
-- Name: asset_program_recipient asset_program_recipient_book_id_asset_id_fkey; Type: FK CONSTRAINT; Schema: economy; Owner: -
--

ALTER TABLE ONLY economy.asset_program_recipient
    ADD CONSTRAINT asset_program_recipient_book_id_asset_id_fkey FOREIGN KEY (book_id, asset_id) REFERENCES economy.asset_program(book_id, asset_id);


--
-- Name: asset_program_source asset_program_source_book_id_asset_id_program_id_fkey; Type: FK CONSTRAINT; Schema: economy; Owner: -
--

ALTER TABLE ONLY economy.asset_program_source
    ADD CONSTRAINT asset_program_source_book_id_asset_id_program_id_fkey FOREIGN KEY (book_id, asset_id, program_id) REFERENCES economy.asset_program(book_id, asset_id, program_id);


--
-- Name: asset_program_source asset_program_source_book_id_asset_id_transaction_id_fkey; Type: FK CONSTRAINT; Schema: economy; Owner: -
--

ALTER TABLE ONLY economy.asset_program_source
    ADD CONSTRAINT asset_program_source_book_id_asset_id_transaction_id_fkey FOREIGN KEY (book_id, asset_id, transaction_id) REFERENCES economy.journal(book_id, asset_id, transaction_id);


--
-- Name: creator_payout creator_payout_book_id_asset_id_reserve_transaction_id_fkey; Type: FK CONSTRAINT; Schema: economy; Owner: -
--

ALTER TABLE ONLY economy.creator_payout
    ADD CONSTRAINT creator_payout_book_id_asset_id_reserve_transaction_id_fkey FOREIGN KEY (book_id, asset_id, reserve_transaction_id) REFERENCES economy.journal(book_id, asset_id, transaction_id);


--
-- Name: creator_posting creator_posting_book_id_asset_id_transaction_id_fkey; Type: FK CONSTRAINT; Schema: economy; Owner: -
--

ALTER TABLE ONLY economy.creator_posting
    ADD CONSTRAINT creator_posting_book_id_asset_id_transaction_id_fkey FOREIGN KEY (book_id, asset_id, transaction_id) REFERENCES economy.journal(book_id, asset_id, transaction_id);


--
-- Name: creator_posting creator_posting_book_id_payout_id_fkey; Type: FK CONSTRAINT; Schema: economy; Owner: -
--

ALTER TABLE ONLY economy.creator_posting
    ADD CONSTRAINT creator_posting_book_id_payout_id_fkey FOREIGN KEY (book_id, payout_id) REFERENCES economy.creator_payout(book_id, payout_id);


--
-- Name: entry entry_book_id_asset_id_account_id_fkey; Type: FK CONSTRAINT; Schema: economy; Owner: -
--

ALTER TABLE ONLY economy.entry
    ADD CONSTRAINT entry_book_id_asset_id_account_id_fkey FOREIGN KEY (book_id, asset_id, account_id) REFERENCES economy."position"(book_id, asset_id, account_id);


--
-- Name: entry entry_book_id_asset_id_transaction_id_fkey; Type: FK CONSTRAINT; Schema: economy; Owner: -
--

ALTER TABLE ONLY economy.entry
    ADD CONSTRAINT entry_book_id_asset_id_transaction_id_fkey FOREIGN KEY (book_id, asset_id, transaction_id) REFERENCES economy.journal(book_id, asset_id, transaction_id);


--
-- Name: funding_control_account funding_control_account_book_id_asset_id_fkey; Type: FK CONSTRAINT; Schema: economy; Owner: -
--

ALTER TABLE ONLY economy.funding_control_account
    ADD CONSTRAINT funding_control_account_book_id_asset_id_fkey FOREIGN KEY (book_id, asset_id) REFERENCES economy.asset(book_id, asset_id);


--
-- Name: funding_dispatch funding_dispatch_active_claim_fk; Type: FK CONSTRAINT; Schema: economy; Owner: -
--

ALTER TABLE ONLY economy.funding_dispatch
    ADD CONSTRAINT funding_dispatch_active_claim_fk FOREIGN KEY (book_id, intent_id, active_claim_id) REFERENCES economy.funding_dispatch_claim(book_id, intent_id, claim_id);


--
-- Name: funding_dispatch funding_dispatch_book_id_intent_id_fkey; Type: FK CONSTRAINT; Schema: economy; Owner: -
--

ALTER TABLE ONLY economy.funding_dispatch
    ADD CONSTRAINT funding_dispatch_book_id_intent_id_fkey FOREIGN KEY (book_id, intent_id) REFERENCES economy.funding_intent(book_id, intent_id);


--
-- Name: funding_dispatch_claim funding_dispatch_claim_book_id_intent_id_fkey; Type: FK CONSTRAINT; Schema: economy; Owner: -
--

ALTER TABLE ONLY economy.funding_dispatch_claim
    ADD CONSTRAINT funding_dispatch_claim_book_id_intent_id_fkey FOREIGN KEY (book_id, intent_id) REFERENCES economy.funding_dispatch(book_id, intent_id);


--
-- Name: funding_evidence funding_evidence_book_id_intent_id_provider_namespace_prov_fkey; Type: FK CONSTRAINT; Schema: economy; Owner: -
--

ALTER TABLE ONLY economy.funding_evidence
    ADD CONSTRAINT funding_evidence_book_id_intent_id_provider_namespace_prov_fkey FOREIGN KEY (book_id, intent_id, provider_namespace, provider_mode) REFERENCES economy.funding_intent(book_id, intent_id, provider_namespace, provider_mode);


--
-- Name: funding_intent funding_intent_book_id_asset_id_fkey; Type: FK CONSTRAINT; Schema: economy; Owner: -
--

ALTER TABLE ONLY economy.funding_intent
    ADD CONSTRAINT funding_intent_book_id_asset_id_fkey FOREIGN KEY (book_id, asset_id) REFERENCES economy.asset(book_id, asset_id);


--
-- Name: funding_posting funding_posting_book_id_asset_id_transaction_id_fkey; Type: FK CONSTRAINT; Schema: economy; Owner: -
--

ALTER TABLE ONLY economy.funding_posting
    ADD CONSTRAINT funding_posting_book_id_asset_id_transaction_id_fkey FOREIGN KEY (book_id, asset_id, transaction_id) REFERENCES economy.journal(book_id, asset_id, transaction_id);


--
-- Name: funding_posting funding_posting_provider_namespace_provider_mode_source_ki_fkey; Type: FK CONSTRAINT; Schema: economy; Owner: -
--

ALTER TABLE ONLY economy.funding_posting
    ADD CONSTRAINT funding_posting_provider_namespace_provider_mode_source_ki_fkey FOREIGN KEY (provider_namespace, provider_mode, source_kind, source_id) REFERENCES economy.funding_evidence(provider_namespace, provider_mode, source_kind, source_id);


--
-- Name: hold_allocation hold_allocation_book_id_asset_id_account_id_hold_id_fkey; Type: FK CONSTRAINT; Schema: economy; Owner: -
--

ALTER TABLE ONLY economy.hold_allocation
    ADD CONSTRAINT hold_allocation_book_id_asset_id_account_id_hold_id_fkey FOREIGN KEY (book_id, asset_id, account_id, hold_id) REFERENCES economy.hold(book_id, asset_id, account_id, hold_id);


--
-- Name: hold_allocation hold_allocation_book_id_asset_id_allocation_transaction_id_fkey; Type: FK CONSTRAINT; Schema: economy; Owner: -
--

ALTER TABLE ONLY economy.hold_allocation
    ADD CONSTRAINT hold_allocation_book_id_asset_id_allocation_transaction_id_fkey FOREIGN KEY (book_id, asset_id, allocation_transaction_id) REFERENCES economy.journal(book_id, asset_id, transaction_id);


--
-- Name: hold_allocation hold_allocation_book_id_asset_id_terminal_transaction_id_fkey; Type: FK CONSTRAINT; Schema: economy; Owner: -
--

ALTER TABLE ONLY economy.hold_allocation
    ADD CONSTRAINT hold_allocation_book_id_asset_id_terminal_transaction_id_fkey FOREIGN KEY (book_id, asset_id, terminal_transaction_id) REFERENCES economy.journal(book_id, asset_id, transaction_id);


--
-- Name: hold hold_book_id_asset_id_account_id_fkey; Type: FK CONSTRAINT; Schema: economy; Owner: -
--

ALTER TABLE ONLY economy.hold
    ADD CONSTRAINT hold_book_id_asset_id_account_id_fkey FOREIGN KEY (book_id, asset_id, account_id) REFERENCES economy."position"(book_id, asset_id, account_id);


--
-- Name: hold hold_book_id_asset_id_reserve_transaction_id_fkey; Type: FK CONSTRAINT; Schema: economy; Owner: -
--

ALTER TABLE ONLY economy.hold
    ADD CONSTRAINT hold_book_id_asset_id_reserve_transaction_id_fkey FOREIGN KEY (book_id, asset_id, reserve_transaction_id) REFERENCES economy.journal(book_id, asset_id, transaction_id);


--
-- Name: journal journal_book_id_asset_id_fkey; Type: FK CONSTRAINT; Schema: economy; Owner: -
--

ALTER TABLE ONLY economy.journal
    ADD CONSTRAINT journal_book_id_asset_id_fkey FOREIGN KEY (book_id, asset_id) REFERENCES economy.asset(book_id, asset_id);


--
-- Name: journal journal_book_id_origin_id_namespace_operation_id_fkey; Type: FK CONSTRAINT; Schema: economy; Owner: -
--

ALTER TABLE ONLY economy.journal
    ADD CONSTRAINT journal_book_id_origin_id_namespace_operation_id_fkey FOREIGN KEY (book_id, origin_id, namespace, operation_id) REFERENCES economy.command_receipt(book_id, origin_id, namespace, operation_id);


--
-- Name: market_funds_receipt market_funds_receipt_book_id_trade_id_fkey; Type: FK CONSTRAINT; Schema: economy; Owner: -
--

ALTER TABLE ONLY economy.market_funds_receipt
    ADD CONSTRAINT market_funds_receipt_book_id_trade_id_fkey FOREIGN KEY (book_id, trade_id) REFERENCES economy.market_funds_trade(book_id, trade_id);


--
-- Name: market_item_listing market_item_listing_home_id_item_id_fkey; Type: FK CONSTRAINT; Schema: economy; Owner: -
--

ALTER TABLE ONLY economy.market_item_listing
    ADD CONSTRAINT market_item_listing_home_id_item_id_fkey FOREIGN KEY (home_id, item_id) REFERENCES economy.market_item(home_id, item_id);


--
-- Name: market_item_trade market_item_trade_home_id_book_id_listing_id_fkey; Type: FK CONSTRAINT; Schema: economy; Owner: -
--

ALTER TABLE ONLY economy.market_item_trade
    ADD CONSTRAINT market_item_trade_home_id_book_id_listing_id_fkey FOREIGN KEY (home_id, book_id, listing_id) REFERENCES economy.market_item_listing(home_id, book_id, listing_id);


--
-- Name: market_trade market_trade_book_id_listing_id_fkey; Type: FK CONSTRAINT; Schema: economy; Owner: -
--

ALTER TABLE ONLY economy.market_trade
    ADD CONSTRAINT market_trade_book_id_listing_id_fkey FOREIGN KEY (book_id, listing_id) REFERENCES economy.market_listing(book_id, listing_id);


--
-- Name: market_work market_work_book_id_listing_id_fkey; Type: FK CONSTRAINT; Schema: economy; Owner: -
--

ALTER TABLE ONLY economy.market_work
    ADD CONSTRAINT market_work_book_id_listing_id_fkey FOREIGN KEY (book_id, listing_id) REFERENCES economy.market_listing(book_id, listing_id);


--
-- Name: market_work market_work_book_id_trade_id_fkey; Type: FK CONSTRAINT; Schema: economy; Owner: -
--

ALTER TABLE ONLY economy.market_work
    ADD CONSTRAINT market_work_book_id_trade_id_fkey FOREIGN KEY (book_id, trade_id) REFERENCES economy.market_trade(book_id, trade_id);


--
-- Name: pending_deposit pending_deposit_book_id_asset_id_fkey; Type: FK CONSTRAINT; Schema: economy; Owner: -
--

ALTER TABLE ONLY economy.pending_deposit
    ADD CONSTRAINT pending_deposit_book_id_asset_id_fkey FOREIGN KEY (book_id, asset_id) REFERENCES economy.asset(book_id, asset_id);


--
-- Name: position position_book_id_asset_id_fkey; Type: FK CONSTRAINT; Schema: economy; Owner: -
--

ALTER TABLE ONLY economy."position"
    ADD CONSTRAINT position_book_id_asset_id_fkey FOREIGN KEY (book_id, asset_id) REFERENCES economy.asset(book_id, asset_id);


--
-- Name: spot_instrument spot_active_order_exists; Type: FK CONSTRAINT; Schema: economy; Owner: -
--

ALTER TABLE ONLY economy.spot_instrument
    ADD CONSTRAINT spot_active_order_exists FOREIGN KEY (book_id, instrument_id, matching_sequence) REFERENCES economy.spot_order(book_id, instrument_id, sequence);


--
-- Name: spot_fill spot_fill_book_id_instrument_id_maker_order_id_fkey; Type: FK CONSTRAINT; Schema: economy; Owner: -
--

ALTER TABLE ONLY economy.spot_fill
    ADD CONSTRAINT spot_fill_book_id_instrument_id_maker_order_id_fkey FOREIGN KEY (book_id, instrument_id, maker_order_id) REFERENCES economy.spot_order(book_id, instrument_id, order_id);


--
-- Name: spot_fill spot_fill_book_id_instrument_id_taker_order_id_fkey; Type: FK CONSTRAINT; Schema: economy; Owner: -
--

ALTER TABLE ONLY economy.spot_fill
    ADD CONSTRAINT spot_fill_book_id_instrument_id_taker_order_id_fkey FOREIGN KEY (book_id, instrument_id, taker_order_id) REFERENCES economy.spot_order(book_id, instrument_id, order_id);


--
-- Name: spot_instrument spot_instrument_book_id_base_asset_id_fkey; Type: FK CONSTRAINT; Schema: economy; Owner: -
--

ALTER TABLE ONLY economy.spot_instrument
    ADD CONSTRAINT spot_instrument_book_id_base_asset_id_fkey FOREIGN KEY (book_id, base_asset_id) REFERENCES economy.asset(book_id, asset_id);


--
-- Name: spot_instrument spot_instrument_book_id_quote_asset_id_fkey; Type: FK CONSTRAINT; Schema: economy; Owner: -
--

ALTER TABLE ONLY economy.spot_instrument
    ADD CONSTRAINT spot_instrument_book_id_quote_asset_id_fkey FOREIGN KEY (book_id, quote_asset_id) REFERENCES economy.asset(book_id, asset_id);


--
-- Name: spot_match_step spot_match_step_book_id_instrument_id_order_id_fkey; Type: FK CONSTRAINT; Schema: economy; Owner: -
--

ALTER TABLE ONLY economy.spot_match_step
    ADD CONSTRAINT spot_match_step_book_id_instrument_id_order_id_fkey FOREIGN KEY (book_id, instrument_id, order_id) REFERENCES economy.spot_order(book_id, instrument_id, order_id);


--
-- Name: spot_order spot_order_book_id_instrument_id_fkey; Type: FK CONSTRAINT; Schema: economy; Owner: -
--

ALTER TABLE ONLY economy.spot_order
    ADD CONSTRAINT spot_order_book_id_instrument_id_fkey FOREIGN KEY (book_id, instrument_id) REFERENCES economy.spot_instrument(book_id, instrument_id);


--
-- Name: spot_settlement spot_settlement_book_id_base_asset_id_base_transaction_id_fkey; Type: FK CONSTRAINT; Schema: economy; Owner: -
--

ALTER TABLE ONLY economy.spot_settlement
    ADD CONSTRAINT spot_settlement_book_id_base_asset_id_base_transaction_id_fkey FOREIGN KEY (book_id, base_asset_id, base_transaction_id) REFERENCES economy.journal(book_id, asset_id, transaction_id);


--
-- Name: spot_settlement spot_settlement_book_id_quote_asset_id_quote_transaction_i_fkey; Type: FK CONSTRAINT; Schema: economy; Owner: -
--

ALTER TABLE ONLY economy.spot_settlement
    ADD CONSTRAINT spot_settlement_book_id_quote_asset_id_quote_transaction_i_fkey FOREIGN KEY (book_id, quote_asset_id, quote_transaction_id) REFERENCES economy.journal(book_id, asset_id, transaction_id);


--
-- PostgreSQL database dump complete
--


