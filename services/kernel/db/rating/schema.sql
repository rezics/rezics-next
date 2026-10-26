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


--
-- Name: nonnegative_histogram(bigint[]); Type: FUNCTION; Schema: rating; Owner: -
--

CREATE FUNCTION rating.nonnegative_histogram(histogram_values bigint[]) RETURNS boolean
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
    AS $$
  SELECT cardinality(histogram_values) > 0
     AND array_position(histogram_values, NULL::bigint) IS NULL
     AND 0::bigint <= ALL(histogram_values)
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: aggregate_component; Type: TABLE; Schema: rating; Owner: -
--

CREATE TABLE rating.aggregate_component (
    route integer NOT NULL,
    question_id uuid NOT NULL,
    population_id uuid NOT NULL,
    target_id uuid NOT NULL,
    shard smallint NOT NULL,
    count bigint NOT NULL,
    sum bigint NOT NULL,
    histogram bigint[] NOT NULL,
    applied_at timestamp with time zone NOT NULL,
    CONSTRAINT aggregate_component_check CHECK ((route = ((get_byte(uuid_send(target_id), 10) * 256) + get_byte(uuid_send(target_id), 11)))),
    CONSTRAINT aggregate_component_count_check CHECK ((count >= 0)),
    CONSTRAINT aggregate_component_histogram_check CHECK (rating.nonnegative_histogram(histogram)),
    CONSTRAINT aggregate_component_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT aggregate_component_shard_check CHECK (((shard >= 0) AND (shard <= 15))),
    CONSTRAINT aggregate_component_sum_check CHECK ((sum >= 0))
);


--
-- Name: population_vote; Type: TABLE; Schema: rating; Owner: -
--

CREATE TABLE rating.population_vote (
    route integer NOT NULL,
    question_id uuid NOT NULL,
    population_id uuid NOT NULL,
    target_id uuid NOT NULL,
    voter_id uuid NOT NULL,
    counting_key text NOT NULL,
    units integer,
    at timestamp with time zone NOT NULL,
    revision integer NOT NULL,
    CONSTRAINT population_vote_check CHECK ((route = ((get_byte(uuid_send(target_id), 10) * 256) + get_byte(uuid_send(target_id), 11)))),
    CONSTRAINT population_vote_counting_key_check CHECK ((counting_key ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT population_vote_revision_check CHECK ((revision >= 1)),
    CONSTRAINT population_vote_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT population_vote_units_check CHECK (((units IS NULL) OR ((units >= 0) AND (units <= 20))))
);


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
-- Name: aggregate_component aggregate_component_pkey; Type: CONSTRAINT; Schema: rating; Owner: -
--

ALTER TABLE ONLY rating.aggregate_component
    ADD CONSTRAINT aggregate_component_pkey PRIMARY KEY (route, question_id, population_id, target_id, shard);


--
-- Name: population_vote population_vote_pkey; Type: CONSTRAINT; Schema: rating; Owner: -
--

ALTER TABLE ONLY rating.population_vote
    ADD CONSTRAINT population_vote_pkey PRIMARY KEY (route, question_id, population_id, target_id, voter_id);


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
-- Name: population_vote_counted_idx; Type: INDEX; Schema: rating; Owner: -
--

CREATE INDEX population_vote_counted_idx ON rating.population_vote USING btree (route, question_id, population_id, target_id, counting_key, at DESC, voter_id) WHERE (units IS NOT NULL);


--
-- Name: population_vote_target_page_idx; Type: INDEX; Schema: rating; Owner: -
--

CREATE INDEX population_vote_target_page_idx ON rating.population_vote USING btree (route, population_id, target_id, question_id, voter_id);


--
-- Name: aggregate_component aggregate_component_question_id_fkey; Type: FK CONSTRAINT; Schema: rating; Owner: -
--

ALTER TABLE ONLY rating.aggregate_component
    ADD CONSTRAINT aggregate_component_question_id_fkey FOREIGN KEY (question_id) REFERENCES rating.question(id);


--
-- Name: population_vote population_vote_question_id_fkey; Type: FK CONSTRAINT; Schema: rating; Owner: -
--

ALTER TABLE ONLY rating.population_vote
    ADD CONSTRAINT population_vote_question_id_fkey FOREIGN KEY (question_id) REFERENCES rating.question(id);


--
-- Name: vote vote_question_id_fkey; Type: FK CONSTRAINT; Schema: rating; Owner: -
--

ALTER TABLE ONLY rating.vote
    ADD CONSTRAINT vote_question_id_fkey FOREIGN KEY (question_id) REFERENCES rating.question(id);


--
-- PostgreSQL database dump complete
--


