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
-- Name: library; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA library;


--
-- Name: guard_follow_target_type(); Type: FUNCTION; Schema: library; Owner: -
--

CREATE FUNCTION library.guard_follow_target_type() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.target_type IS DISTINCT FROM OLD.target_type THEN
    RAISE EXCEPTION 'Follow target type cannot change' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: follow; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.follow (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    target_id uuid NOT NULL,
    target_type text NOT NULL,
    state text NOT NULL,
    reason text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    transaction_id uuid NOT NULL,
    CONSTRAINT follow_check CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT follow_check1 CHECK (((reason = 'explicit'::text) OR (state = 'following'::text))),
    CONSTRAINT follow_reason_check CHECK ((reason = ANY (ARRAY['explicit'::text, 'library'::text, 'membership'::text]))),
    CONSTRAINT follow_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT follow_state_check CHECK ((state = ANY (ARRAY['following'::text, 'unfollowed'::text]))),
    CONSTRAINT follow_target_type_check CHECK ((target_type = ANY (ARRAY['subject'::text, 'collection'::text, 'space'::text])))
);


--
-- Name: follow follow_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.follow
    ADD CONSTRAINT follow_pkey PRIMARY KEY (route, account_id, target_id);


--
-- Name: follow_account_page; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX follow_account_page ON library.follow USING btree (route, account_id, state, updated_at DESC, target_id);


--
-- Name: follow follow_target_type_immutable; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER follow_target_type_immutable BEFORE UPDATE OF target_type ON library.follow FOR EACH ROW EXECUTE FUNCTION library.guard_follow_target_type();


--
-- PostgreSQL database dump complete
--


