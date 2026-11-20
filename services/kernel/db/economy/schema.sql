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
    CONSTRAINT command_receipt_outcome_check CHECK ((outcome = ANY (ARRAY['ok'::text, 'asset_missing'::text, 'operation_conflict'::text, 'insufficient_funds'::text, 'asset_not_transferable'::text, 'hold_missing'::text, 'hold_closed'::text, 'allocation_missing'::text, 'allocation_closed'::text, 'invalid_amount'::text, 'invalid_operation'::text])))
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
    CONSTRAINT journal_check CHECK (((kind = 'transfer'::text) = (namespace = 'wallet'::text))),
    CONSTRAINT journal_hold_kind_check CHECK (((kind <> ALL (ARRAY['issue'::text, 'transfer'::text])) = (hold_id IS NOT NULL))),
    CONSTRAINT journal_kind_check CHECK ((kind = ANY (ARRAY['issue'::text, 'transfer'::text, 'reserve'::text, 'capture'::text, 'release'::text, 'expire'::text, 'release_amount'::text, 'allocate'::text, 'capture_allocation'::text, 'release_allocation'::text])))
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
    CONSTRAINT position_check CHECK (((held >= 0) AND (restricted >= 0))),
    CONSTRAINT position_check1 CHECK ((((account_id = '00000000-0000-0000-0000-000000000000'::uuid) AND (held = 0) AND (restricted = 0)) OR ((posted >= 0) AND (((held)::numeric + (restricted)::numeric) <= (posted)::numeric)))),
    CONSTRAINT position_revision_check CHECK ((revision >= 0))
);


--
-- Name: asset asset_pkey; Type: CONSTRAINT; Schema: economy; Owner: -
--

ALTER TABLE ONLY economy.asset
    ADD CONSTRAINT asset_pkey PRIMARY KEY (book_id, asset_id);


--
-- Name: command_receipt command_receipt_pkey; Type: CONSTRAINT; Schema: economy; Owner: -
--

ALTER TABLE ONLY economy.command_receipt
    ADD CONSTRAINT command_receipt_pkey PRIMARY KEY (book_id, origin_id, namespace, operation_id);


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
-- Name: position position_pkey; Type: CONSTRAINT; Schema: economy; Owner: -
--

ALTER TABLE ONLY economy."position"
    ADD CONSTRAINT position_pkey PRIMARY KEY (book_id, asset_id, account_id);


--
-- Name: hold_due_idx; Type: INDEX; Schema: economy; Owner: -
--

CREATE INDEX hold_due_idx ON economy.hold USING btree (book_id, expires_at, asset_id, account_id, hold_id) WHERE (remaining > allocated);


--
-- Name: asset asset_immutable; Type: TRIGGER; Schema: economy; Owner: -
--

CREATE TRIGGER asset_immutable BEFORE DELETE OR UPDATE ON economy.asset FOR EACH ROW EXECUTE FUNCTION economy.reject_history_edit();


--
-- Name: entry entry_immutable; Type: TRIGGER; Schema: economy; Owner: -
--

CREATE TRIGGER entry_immutable BEFORE DELETE OR UPDATE ON economy.entry FOR EACH ROW EXECUTE FUNCTION economy.reject_history_edit();


--
-- Name: journal journal_immutable; Type: TRIGGER; Schema: economy; Owner: -
--

CREATE TRIGGER journal_immutable BEFORE DELETE OR UPDATE ON economy.journal FOR EACH ROW EXECUTE FUNCTION economy.reject_history_edit();


--
-- Name: command_receipt receipt_immutable; Type: TRIGGER; Schema: economy; Owner: -
--

CREATE TRIGGER receipt_immutable BEFORE DELETE OR UPDATE ON economy.command_receipt FOR EACH ROW EXECUTE FUNCTION economy.reject_history_edit();


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
-- Name: position position_book_id_asset_id_fkey; Type: FK CONSTRAINT; Schema: economy; Owner: -
--

ALTER TABLE ONLY economy."position"
    ADD CONSTRAINT position_book_id_asset_id_fkey FOREIGN KEY (book_id, asset_id) REFERENCES economy.asset(book_id, asset_id);


--
-- PostgreSQL database dump complete
--


