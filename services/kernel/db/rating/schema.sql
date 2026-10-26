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
-- Name: rating; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA rating;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: question; Type: TABLE; Schema: rating; Owner: -
--

CREATE TABLE rating.question (
    id uuid NOT NULL,
    owner_id uuid,
    revision integer NOT NULL,
    label text NOT NULL,
    grain text NOT NULL,
    minimum_units integer NOT NULL,
    maximum_units integer NOT NULL,
    step_units integer NOT NULL,
    CONSTRAINT question_check CHECK (((minimum_units >= 0) AND (maximum_units >= minimum_units) AND (step_units > 0))),
    CONSTRAINT question_check1 CHECK ((((maximum_units - minimum_units) % step_units) = 0)),
    CONSTRAINT question_grain_check CHECK ((grain = ANY (ARRAY['work'::text, 'release'::text, 'episode'::text, 'character'::text]))),
    CONSTRAINT question_label_check CHECK (((char_length(label) >= 1) AND (char_length(label) <= 200))),
    CONSTRAINT question_revision_check CHECK ((revision >= 1))
);


--
-- Name: vote; Type: TABLE; Schema: rating; Owner: -
--

CREATE TABLE rating.vote (
    route integer NOT NULL,
    voter_id uuid NOT NULL,
    question_id uuid NOT NULL,
    target_id uuid NOT NULL,
    units integer,
    revision integer NOT NULL,
    changed_at timestamp with time zone NOT NULL,
    transaction_id uuid NOT NULL,
    CONSTRAINT vote_check CHECK ((route = ((get_byte(uuid_send(voter_id), 10) * 256) + get_byte(uuid_send(voter_id), 11)))),
    CONSTRAINT vote_revision_check CHECK ((revision >= 1)),
    CONSTRAINT vote_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT vote_units_check CHECK (((units IS NULL) OR ((units >= 0) AND (units <= 20))))
);


--
-- Name: question question_pkey; Type: CONSTRAINT; Schema: rating; Owner: -
--

ALTER TABLE ONLY rating.question
    ADD CONSTRAINT question_pkey PRIMARY KEY (id);


--
-- Name: vote vote_pkey; Type: CONSTRAINT; Schema: rating; Owner: -
--

ALTER TABLE ONLY rating.vote
    ADD CONSTRAINT vote_pkey PRIMARY KEY (route, voter_id, question_id, target_id);


--
-- Name: vote vote_question_id_fkey; Type: FK CONSTRAINT; Schema: rating; Owner: -
--

ALTER TABLE ONLY rating.vote
    ADD CONSTRAINT vote_question_id_fkey FOREIGN KEY (question_id) REFERENCES rating.question(id);


--
-- PostgreSQL database dump complete
--


