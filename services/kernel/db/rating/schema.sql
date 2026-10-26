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
-- Name: population_pending; Type: TABLE; Schema: rating; Owner: -
--

CREATE TABLE rating.population_pending (
    route integer NOT NULL,
    population_id uuid NOT NULL,
    pending_jobs integer NOT NULL,
    CONSTRAINT population_pending_check CHECK ((route = ((get_byte(uuid_send(population_id), 10) * 256) + get_byte(uuid_send(population_id), 11)))),
    CONSTRAINT population_pending_pending_jobs_check CHECK ((pending_jobs >= 0)),
    CONSTRAINT population_pending_route_check CHECK (((route >= 0) AND (route <= 65535)))
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
-- Name: source_statistic; Type: TABLE; Schema: rating; Owner: -
--

CREATE TABLE rating.source_statistic (
    route integer NOT NULL,
    subject_id uuid NOT NULL,
    source text NOT NULL,
    source_record_id text NOT NULL,
    scale_min integer NOT NULL,
    scale_max integer NOT NULL,
    mean numeric NOT NULL,
    count integer NOT NULL,
    as_of date NOT NULL,
    licence text NOT NULL,
    attribution text NOT NULL,
    transaction_id uuid NOT NULL,
    CONSTRAINT source_statistic_attribution_check CHECK (((char_length(attribution) >= 1) AND (char_length(attribution) <= 2000))),
    CONSTRAINT source_statistic_check CHECK ((scale_max > scale_min)),
    CONSTRAINT source_statistic_check1 CHECK (((mean >= (scale_min)::numeric) AND (mean <= (scale_max)::numeric))),
    CONSTRAINT source_statistic_check2 CHECK ((route = ((get_byte(uuid_send(subject_id), 10) * 256) + get_byte(uuid_send(subject_id), 11)))),
    CONSTRAINT source_statistic_count_check CHECK ((count > 0)),
    CONSTRAINT source_statistic_licence_check CHECK (((char_length(licence) >= 1) AND (char_length(licence) <= 1024))),
    CONSTRAINT source_statistic_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT source_statistic_scale_min_check CHECK ((scale_min >= 0)),
    CONSTRAINT source_statistic_source_check CHECK ((source = 'vndb'::text)),
    CONSTRAINT source_statistic_source_record_id_check CHECK (((char_length(source_record_id) >= 1) AND (char_length(source_record_id) <= 1024)))
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
-- Name: voter_realm; Type: TABLE; Schema: rating; Owner: -
--

CREATE TABLE rating.voter_realm (
    route integer NOT NULL,
    voter_id uuid NOT NULL,
    realm_id uuid NOT NULL,
    joined_at timestamp with time zone NOT NULL,
    state text NOT NULL,
    cursor_question_id uuid,
    cursor_target_id uuid,
    limit_question_id uuid,
    limit_target_id uuid,
    rejoin boolean DEFAULT false NOT NULL,
    transition_id uuid DEFAULT gen_random_uuid() NOT NULL,
    CONSTRAINT voter_realm_check CHECK ((route = ((get_byte(uuid_send(voter_id), 10) * 256) + get_byte(uuid_send(voter_id), 11)))),
    CONSTRAINT voter_realm_check1 CHECK (((cursor_question_id IS NULL) = (cursor_target_id IS NULL))),
    CONSTRAINT voter_realm_check2 CHECK (((limit_question_id IS NULL) = (limit_target_id IS NULL))),
    CONSTRAINT voter_realm_check3 CHECK (((state = ANY (ARRAY['adding'::text, 'removing'::text])) OR (cursor_question_id IS NULL))),
    CONSTRAINT voter_realm_check4 CHECK (((state = 'removing'::text) OR ((limit_question_id IS NULL) AND (NOT rejoin)))),
    CONSTRAINT voter_realm_check5 CHECK (((cursor_question_id IS NULL) OR (limit_question_id IS NULL) OR (ROW(cursor_question_id, cursor_target_id) <= ROW(limit_question_id, limit_target_id)))),
    CONSTRAINT voter_realm_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT voter_realm_state_check CHECK ((state = ANY (ARRAY['adding'::text, 'counted'::text, 'removing'::text, 'uncounted'::text])))
);


--
-- Name: aggregate_component aggregate_component_pkey; Type: CONSTRAINT; Schema: rating; Owner: -
--

ALTER TABLE ONLY rating.aggregate_component
    ADD CONSTRAINT aggregate_component_pkey PRIMARY KEY (route, question_id, population_id, target_id, shard);


--
-- Name: population_pending population_pending_pkey; Type: CONSTRAINT; Schema: rating; Owner: -
--

ALTER TABLE ONLY rating.population_pending
    ADD CONSTRAINT population_pending_pkey PRIMARY KEY (route, population_id);


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
-- Name: source_statistic source_statistic_pkey; Type: CONSTRAINT; Schema: rating; Owner: -
--

ALTER TABLE ONLY rating.source_statistic
    ADD CONSTRAINT source_statistic_pkey PRIMARY KEY (route, subject_id, source);


--
-- Name: vote vote_pkey; Type: CONSTRAINT; Schema: rating; Owner: -
--

ALTER TABLE ONLY rating.vote
    ADD CONSTRAINT vote_pkey PRIMARY KEY (route, voter_id, question_id, target_id);


--
-- Name: voter_realm voter_realm_pkey; Type: CONSTRAINT; Schema: rating; Owner: -
--

ALTER TABLE ONLY rating.voter_realm
    ADD CONSTRAINT voter_realm_pkey PRIMARY KEY (route, voter_id, realm_id);


--
-- Name: population_vote_counted_idx; Type: INDEX; Schema: rating; Owner: -
--

CREATE INDEX population_vote_counted_idx ON rating.population_vote USING btree (route, question_id, population_id, target_id, counting_key, at DESC, voter_id) WHERE (units IS NOT NULL);


--
-- Name: population_vote_target_page_idx; Type: INDEX; Schema: rating; Owner: -
--

CREATE INDEX population_vote_target_page_idx ON rating.population_vote USING btree (route, population_id, target_id, question_id, voter_id);


--
-- Name: voter_realm_capped_idx; Type: INDEX; Schema: rating; Owner: -
--

CREATE INDEX voter_realm_capped_idx ON rating.voter_realm USING btree (route, voter_id, realm_id) WHERE (state <> 'uncounted'::text);


--
-- Name: voter_realm_waiting_idx; Type: INDEX; Schema: rating; Owner: -
--

CREATE INDEX voter_realm_waiting_idx ON rating.voter_realm USING btree (route, voter_id, joined_at, realm_id) WHERE (state = 'uncounted'::text);


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
-- Name: source_statistic source_statistic_route_subject_id_fkey; Type: FK CONSTRAINT; Schema: rating; Owner: -
--

ALTER TABLE ONLY rating.source_statistic
    ADD CONSTRAINT source_statistic_route_subject_id_fkey FOREIGN KEY (route, subject_id) REFERENCES semantic.subject(route, subject_id);


--
-- Name: vote vote_question_id_fkey; Type: FK CONSTRAINT; Schema: rating; Owner: -
--

ALTER TABLE ONLY rating.vote
    ADD CONSTRAINT vote_question_id_fkey FOREIGN KEY (question_id) REFERENCES rating.question(id);


--
-- PostgreSQL database dump complete
--


