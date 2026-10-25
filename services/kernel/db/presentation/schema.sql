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
-- Name: presentation; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA presentation;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: profile; Type: TABLE; Schema: presentation; Owner: -
--

CREATE TABLE presentation.profile (
    route integer NOT NULL,
    digest text NOT NULL,
    body jsonb NOT NULL,
    recorded_transaction_id uuid NOT NULL,
    CONSTRAINT profile_digest_check CHECK ((digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT profile_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: profile_activation; Type: TABLE; Schema: presentation; Owner: -
--

CREATE TABLE presentation.profile_activation (
    route integer NOT NULL,
    head integer NOT NULL,
    digest text NOT NULL,
    recorded_transaction_id uuid NOT NULL,
    CONSTRAINT profile_activation_head_check CHECK ((head >= 1)),
    CONSTRAINT profile_activation_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: profile_activation profile_activation_pkey; Type: CONSTRAINT; Schema: presentation; Owner: -
--

ALTER TABLE ONLY presentation.profile_activation
    ADD CONSTRAINT profile_activation_pkey PRIMARY KEY (route, head);


--
-- Name: profile profile_pkey; Type: CONSTRAINT; Schema: presentation; Owner: -
--

ALTER TABLE ONLY presentation.profile
    ADD CONSTRAINT profile_pkey PRIMARY KEY (route, digest);


--
-- Name: profile_activation profile_activation_route_digest_fkey; Type: FK CONSTRAINT; Schema: presentation; Owner: -
--

ALTER TABLE ONLY presentation.profile_activation
    ADD CONSTRAINT profile_activation_route_digest_fkey FOREIGN KEY (route, digest) REFERENCES presentation.profile(route, digest);


--
-- PostgreSQL database dump complete
--


