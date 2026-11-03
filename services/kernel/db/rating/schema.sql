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
-- Name: initialize_question_label(); Type: FUNCTION; Schema: rating; Owner: -
--

CREATE FUNCTION rating.initialize_question_label() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.realm_id IS NOT NULL THEN
    INSERT INTO rating.question_label_head (question_id, revision, label) VALUES (NEW.id, 1, NEW.label);
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: initialize_vote_counting(); Type: FUNCTION; Schema: rating; Owner: -
--

CREATE FUNCTION rating.initialize_vote_counting() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.counted_target IS NULL THEN NEW.counted_target := NEW.target_id; END IF;
  NEW.counted_revision := GREATEST(NEW.counted_revision, NEW.revision);
  RETURN NEW;
END;
$$;


--
-- Name: keep_question_definition(); Type: FUNCTION; Schema: rating; Owner: -
--

CREATE FUNCTION rating.keep_question_definition() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF (OLD.realm_id IS NOT NULL OR NEW.realm_id IS NOT NULL) AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Realm question definitions are immutable; create another question';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: keep_question_label_revision(); Type: FUNCTION; Schema: rating; Owner: -
--

CREATE FUNCTION rating.keep_question_label_revision() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'Question caption revisions are immutable';
END;
$$;


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


--
-- Name: publish_realm_rank(); Type: FUNCTION; Schema: rating; Owner: -
--

CREATE FUNCTION rating.publish_realm_rank() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE changed integer;
BEGIN
  IF TG_OP <> 'DELETE' AND NEW.population_id <> '00000000-0000-8000-8000-000000000000'::uuid
     AND NEW.score IS NOT NULL AND NEW.as_of IS NOT NULL THEN
    INSERT INTO rating.realm_rank
      (partition_no,question_id,population_id,subject_id,count,mean,score,prior_epoch,prior_generation,revision,as_of)
    VALUES (NEW.partition_no,NEW.question_id,NEW.population_id,NEW.subject_id,NEW.count,NEW.mean,NEW.score,
            NEW.prior_epoch,NEW.published_prior_generation,NEW.revision,NEW.as_of)
    ON CONFLICT (partition_no,question_id,population_id,subject_id) DO UPDATE
      SET count=EXCLUDED.count,mean=EXCLUDED.mean,score=EXCLUDED.score,prior_epoch=EXCLUDED.prior_epoch,
          prior_generation=EXCLUDED.prior_generation,revision=EXCLUDED.revision,as_of=EXCLUDED.as_of
      WHERE (realm_rank.count,realm_rank.mean,realm_rank.score,realm_rank.prior_epoch,
             realm_rank.prior_generation,realm_rank.revision,realm_rank.as_of)
        IS DISTINCT FROM (EXCLUDED.count,EXCLUDED.mean,EXCLUDED.score,EXCLUDED.prior_epoch,
                          EXCLUDED.prior_generation,EXCLUDED.revision,EXCLUDED.as_of);
  ELSE
    DELETE FROM rating.realm_rank
      WHERE partition_no=OLD.partition_no AND question_id=OLD.question_id
        AND population_id=OLD.population_id AND subject_id=OLD.subject_id;
  END IF;
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed > 0 THEN
    INSERT INTO rating.realm_rank_generation(partition_no,question_id,population_id,generation)
    VALUES (COALESCE(NEW.partition_no,OLD.partition_no),COALESCE(NEW.question_id,OLD.question_id),
            COALESCE(NEW.population_id,OLD.population_id),1)
    ON CONFLICT (partition_no,question_id,population_id) DO UPDATE
      SET generation=realm_rank_generation.generation+1;
  END IF;
  RETURN NULL;
END;
$$;


--
-- Name: require_population_total_delivery(); Type: FUNCTION; Schema: rating; Owner: -
--

CREATE FUNCTION rating.require_population_total_delivery() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF (TG_OP = 'INSERT' OR (NEW.count, NEW.sum) IS DISTINCT FROM (OLD.count, OLD.sum))
     AND current_setting('rating.population_total_writer', true) IS DISTINCT FROM 'population-home-v1' THEN
    RAISE EXCEPTION 'Rating population totals require population-home delivery';
  END IF;
  RETURN NEW;
END;
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
-- Name: erasure_page; Type: TABLE; Schema: rating; Owner: -
--

CREATE TABLE rating.erasure_page (
    route integer NOT NULL,
    voter_id uuid NOT NULL,
    page_id uuid NOT NULL,
    terminal boolean NOT NULL,
    had_votes boolean DEFAULT false NOT NULL,
    CONSTRAINT erasure_page_check CHECK ((route = ((get_byte(uuid_send(voter_id), 10) * 256) + get_byte(uuid_send(voter_id), 11)))),
    CONSTRAINT erasure_page_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: identity_repair_receipt; Type: TABLE; Schema: rating; Owner: -
--

CREATE TABLE rating.identity_repair_receipt (
    route integer NOT NULL,
    voter_id uuid NOT NULL,
    page_id uuid NOT NULL,
    work_id uuid NOT NULL,
    generation bigint NOT NULL,
    digest text NOT NULL,
    transaction_id uuid NOT NULL,
    obligation_id text,
    mapping_digest text,
    checkpoint jsonb,
    terminal boolean NOT NULL,
    mode text NOT NULL,
    CONSTRAINT identity_repair_receipt_authority_check CHECK ((((mode = 'repair'::text) AND (obligation_id IS NOT NULL) AND (mapping_digest IS NOT NULL)) OR ((mode = 'withdrawal'::text) AND (obligation_id IS NULL) AND (mapping_digest IS NULL)))),
    CONSTRAINT identity_repair_receipt_digest_check CHECK ((digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT identity_repair_receipt_generation_check CHECK ((generation > 0)),
    CONSTRAINT identity_repair_receipt_mapping_digest_check CHECK ((mapping_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT identity_repair_receipt_mode_check CHECK ((mode = ANY (ARRAY['repair'::text, 'withdrawal'::text]))),
    CONSTRAINT identity_repair_receipt_obligation_id_check CHECK ((octet_length(obligation_id) <= 255)),
    CONSTRAINT identity_repair_receipt_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT identity_repair_receipt_voter_route_check CHECK ((route = ((get_byte(uuid_send(voter_id), 10) * 256) + get_byte(uuid_send(voter_id), 11))))
);


--
-- Name: identity_work_frame; Type: TABLE; Schema: rating; Owner: -
--

CREATE TABLE rating.identity_work_frame (
    route integer NOT NULL,
    voter_id uuid NOT NULL,
    generation bigint NOT NULL,
    work_id uuid NOT NULL,
    state text NOT NULL,
    mode text NOT NULL,
    cursor jsonb,
    through_key jsonb,
    selected jsonb,
    CONSTRAINT identity_work_frame_generation_check CHECK ((generation > 0)),
    CONSTRAINT identity_work_frame_mode_check CHECK ((mode = ANY (ARRAY['repair'::text, 'withdrawal'::text]))),
    CONSTRAINT identity_work_frame_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT identity_work_frame_selected_check CHECK ((octet_length(jsonb_send(selected)) <= 65537)),
    CONSTRAINT identity_work_frame_state_check CHECK ((state = ANY (ARRAY['active'::text, 'complete'::text, 'cancelled'::text]))),
    CONSTRAINT identity_work_frame_voter_route_check CHECK ((route = ((get_byte(uuid_send(voter_id), 10) * 256) + get_byte(uuid_send(voter_id), 11))))
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
-- Name: population_prior_epoch; Type: TABLE; Schema: rating; Owner: -
--

CREATE TABLE rating.population_prior_epoch (
    route integer NOT NULL,
    partition_no integer GENERATED ALWAYS AS ((route >> 4)) STORED,
    question_id uuid NOT NULL,
    population_id uuid NOT NULL,
    epoch integer DEFAULT 0 NOT NULL,
    generation bigint DEFAULT 0 NOT NULL,
    start_count bigint,
    m numeric(12,4),
    c bigint,
    CONSTRAINT population_prior_epoch_c_check CHECK (((c IS NULL) OR (c >= 1))),
    CONSTRAINT population_prior_epoch_check CHECK ((route = ((get_byte(uuid_send(population_id), 10) * 256) + get_byte(uuid_send(population_id), 11)))),
    CONSTRAINT population_prior_epoch_check1 CHECK ((((start_count IS NULL) AND (m IS NULL) AND (c IS NULL)) OR ((start_count IS NOT NULL) AND (m IS NOT NULL) AND (c IS NOT NULL)))),
    CONSTRAINT population_prior_epoch_check2 CHECK ((((epoch = 0) AND (start_count IS NULL)) OR (epoch >= 1))),
    CONSTRAINT population_prior_epoch_epoch_check CHECK ((epoch >= 0)),
    CONSTRAINT population_prior_epoch_generation_check CHECK ((generation >= 0)),
    CONSTRAINT population_prior_epoch_m_check CHECK (((m IS NULL) OR ((m >= (0)::numeric) AND (m <= (10)::numeric)))),
    CONSTRAINT population_prior_epoch_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT population_prior_epoch_start_count_check CHECK (((start_count IS NULL) OR (start_count >= 50)))
);


--
-- Name: population_prior_republish; Type: TABLE; Schema: rating; Owner: -
--

CREATE TABLE rating.population_prior_republish (
    route integer NOT NULL,
    partition_no integer GENERATED ALWAYS AS ((route >> 4)) STORED,
    question_id uuid NOT NULL,
    population_id uuid NOT NULL,
    generation bigint NOT NULL,
    after_subject_id uuid,
    CONSTRAINT population_prior_republish_check CHECK ((route = ((get_byte(uuid_send(population_id), 10) * 256) + get_byte(uuid_send(population_id), 11)))),
    CONSTRAINT population_prior_republish_generation_check CHECK ((generation >= 1)),
    CONSTRAINT population_prior_republish_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: population_total_clock; Type: TABLE; Schema: rating; Owner: -
--

CREATE TABLE rating.population_total_clock (
    partition_no integer NOT NULL,
    generation bigint NOT NULL,
    pending bigint NOT NULL,
    CONSTRAINT population_total_clock_generation_check CHECK ((generation > 0)),
    CONSTRAINT population_total_clock_partition_no_check CHECK (((partition_no >= 0) AND (partition_no <= 4095))),
    CONSTRAINT population_total_clock_pending_check CHECK ((pending >= 0))
);


--
-- Name: population_total_component; Type: TABLE; Schema: rating; Owner: -
--

CREATE TABLE rating.population_total_component (
    route integer NOT NULL,
    partition_no integer GENERATED ALWAYS AS ((route >> 4)) STORED,
    question_id uuid NOT NULL,
    population_id uuid NOT NULL,
    shard smallint NOT NULL,
    count bigint NOT NULL,
    sum bigint NOT NULL,
    needs_epoch_check boolean DEFAULT false NOT NULL,
    CONSTRAINT population_total_component_check CHECK ((route = ((get_byte(uuid_send(population_id), 10) * 256) + get_byte(uuid_send(population_id), 11)))),
    CONSTRAINT population_total_component_count_check CHECK ((count >= 0)),
    CONSTRAINT population_total_component_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT population_total_component_shard_check CHECK (((shard >= 0) AND (shard <= 15))),
    CONSTRAINT population_total_component_sum_check CHECK ((sum >= 0))
);


--
-- Name: population_total_delivery; Type: TABLE; Schema: rating; Owner: -
--

CREATE TABLE rating.population_total_delivery (
    partition_no integer NOT NULL,
    population_id uuid NOT NULL,
    serial bigint NOT NULL,
    payload jsonb NOT NULL,
    pending boolean DEFAULT true NOT NULL,
    CONSTRAINT population_total_delivery_partition_no_check CHECK (((partition_no >= 0) AND (partition_no <= 4095))),
    CONSTRAINT population_total_delivery_payload_check CHECK (((jsonb_typeof(payload) = 'object'::text) AND (octet_length((payload)::text) <= 65536))),
    CONSTRAINT population_total_delivery_serial_check CHECK ((serial > 0))
);


--
-- Name: population_total_inbox; Type: TABLE; Schema: rating; Owner: -
--

CREATE TABLE rating.population_total_inbox (
    route integer NOT NULL,
    partition_no integer GENERATED ALWAYS AS ((route >> 4)) STORED,
    population_id uuid NOT NULL,
    source_partition integer NOT NULL,
    serial bigint NOT NULL,
    payload jsonb NOT NULL,
    applied boolean DEFAULT false NOT NULL,
    CONSTRAINT population_total_inbox_check CHECK ((route = ((get_byte(uuid_send(population_id), 10) * 256) + get_byte(uuid_send(population_id), 11)))),
    CONSTRAINT population_total_inbox_payload_check CHECK (((jsonb_typeof(payload) = 'object'::text) AND (octet_length((payload)::text) <= 65536))),
    CONSTRAINT population_total_inbox_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT population_total_inbox_serial_check CHECK ((serial > 0)),
    CONSTRAINT population_total_inbox_source_partition_check CHECK (((source_partition >= 0) AND (source_partition <= 4095)))
);


--
-- Name: population_total_received; Type: TABLE; Schema: rating; Owner: -
--

CREATE TABLE rating.population_total_received (
    route integer NOT NULL,
    partition_no integer GENERATED ALWAYS AS ((route >> 4)) STORED,
    population_id uuid NOT NULL,
    source_partition integer NOT NULL,
    serial bigint DEFAULT 0 NOT NULL,
    CONSTRAINT population_total_received_check CHECK ((route = ((get_byte(uuid_send(population_id), 10) * 256) + get_byte(uuid_send(population_id), 11)))),
    CONSTRAINT population_total_received_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT population_total_received_serial_check CHECK ((serial >= 0)),
    CONSTRAINT population_total_received_source_partition_check CHECK (((source_partition >= 0) AND (source_partition <= 4095)))
);


--
-- Name: population_total_source; Type: TABLE; Schema: rating; Owner: -
--

CREATE TABLE rating.population_total_source (
    partition_no integer NOT NULL,
    population_id uuid NOT NULL,
    serial bigint NOT NULL,
    CONSTRAINT population_total_source_partition_no_check CHECK (((partition_no >= 0) AND (partition_no <= 4095))),
    CONSTRAINT population_total_source_serial_check CHECK ((serial > 0))
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
-- Name: population_vote_removal; Type: TABLE; Schema: rating; Owner: -
--

CREATE TABLE rating.population_vote_removal (
    route integer NOT NULL,
    question_id uuid NOT NULL,
    population_id uuid NOT NULL,
    target_id uuid NOT NULL,
    voter_id uuid NOT NULL,
    revision integer NOT NULL,
    CONSTRAINT population_vote_removal_check CHECK ((route = ((get_byte(uuid_send(target_id), 10) * 256) + get_byte(uuid_send(target_id), 11)))),
    CONSTRAINT population_vote_removal_revision_check CHECK ((revision >= 1)),
    CONSTRAINT population_vote_removal_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: public_figure; Type: TABLE; Schema: rating; Owner: -
--

CREATE TABLE rating.public_figure (
    route integer NOT NULL,
    partition_no integer GENERATED ALWAYS AS ((route >> 4)) STORED,
    question_id uuid NOT NULL,
    population_id uuid NOT NULL,
    subject_id uuid NOT NULL,
    count bigint DEFAULT 0 NOT NULL,
    mean numeric(12,4),
    score numeric(12,4),
    m numeric(12,4),
    c bigint,
    prior_epoch integer,
    revision bigint DEFAULT 0 NOT NULL,
    as_of timestamp with time zone,
    "position" bigint DEFAULT 0 NOT NULL,
    pending_position bigint,
    pending_prior_generation bigint,
    published_prior_generation bigint DEFAULT 0 NOT NULL,
    CONSTRAINT public_figure_check CHECK (((pending_position IS NULL) OR (pending_position > "position"))),
    CONSTRAINT public_figure_check1 CHECK ((route = ((get_byte(uuid_send(subject_id), 10) * 256) + get_byte(uuid_send(subject_id), 11)))),
    CONSTRAINT public_figure_check2 CHECK ((((mean IS NULL) OR ((mean >= (0)::numeric) AND (mean <= (10)::numeric))) AND ((m IS NULL) OR ((m >= (0)::numeric) AND (m <= (10)::numeric))))),
    CONSTRAINT public_figure_check3 CHECK ((((score IS NULL) OR ((score >= (0)::numeric) AND (score <= (10)::numeric))) AND ((c IS NULL) OR (c >= 1)))),
    CONSTRAINT public_figure_count_check CHECK ((count >= 0)),
    CONSTRAINT public_figure_pending_prior_generation_check CHECK (((pending_prior_generation IS NULL) OR (pending_prior_generation > 0))),
    CONSTRAINT public_figure_position_check CHECK (("position" >= 0)),
    CONSTRAINT public_figure_prior_epoch_check CHECK (((prior_epoch IS NULL) OR (prior_epoch >= 1))),
    CONSTRAINT public_figure_published_prior_generation_check CHECK ((published_prior_generation >= 0)),
    CONSTRAINT public_figure_revision_check CHECK ((revision >= 0)),
    CONSTRAINT public_figure_route_check CHECK (((route >= 0) AND (route <= 65535)))
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
    realm_id uuid,
    meaning text,
    CONSTRAINT question_check CHECK (((minimum_units >= 0) AND (maximum_units >= minimum_units) AND (step_units > 0))),
    CONSTRAINT question_check1 CHECK ((((maximum_units - minimum_units) % step_units) = 0)),
    CONSTRAINT question_grain_check CHECK ((grain = ANY (ARRAY['work'::text, 'release'::text, 'episode'::text, 'character'::text]))),
    CONSTRAINT question_label_check CHECK (((char_length(label) >= 1) AND (char_length(label) <= 200))),
    CONSTRAINT question_realm_definition_check CHECK ((((realm_id IS NULL) AND (meaning IS NULL)) OR ((realm_id IS NOT NULL) AND (owner_id IS NOT NULL) AND (meaning IS NOT NULL) AND ((char_length(btrim(meaning)) >= 1) AND (char_length(btrim(meaning)) <= 2000)) AND ((char_length(btrim(label)) >= 1) AND (char_length(btrim(label)) <= 200)) AND (minimum_units >= 0) AND (maximum_units <= 20) AND (maximum_units > minimum_units) AND (get_byte(uuid_send(id), 10) = get_byte(uuid_send(realm_id), 10)) AND (get_byte(uuid_send(id), 11) = get_byte(uuid_send(realm_id), 11))))),
    CONSTRAINT question_revision_check CHECK ((revision >= 1))
);


--
-- Name: question_label_head; Type: TABLE; Schema: rating; Owner: -
--

CREATE TABLE rating.question_label_head (
    question_id uuid NOT NULL,
    revision integer NOT NULL,
    label text NOT NULL,
    CONSTRAINT question_label_head_label_check CHECK ((((char_length(label) >= 1) AND (char_length(label) <= 200)) AND (length(btrim(label)) > 0))),
    CONSTRAINT question_label_head_revision_check CHECK ((revision >= 1))
);


--
-- Name: question_label_revision; Type: TABLE; Schema: rating; Owner: -
--

CREATE TABLE rating.question_label_revision (
    question_id uuid NOT NULL,
    revision integer NOT NULL,
    label text NOT NULL,
    author_id uuid NOT NULL,
    changed_at timestamp with time zone NOT NULL,
    CONSTRAINT question_label_revision_label_check CHECK ((((char_length(label) >= 1) AND (char_length(label) <= 200)) AND (length(btrim(label)) > 0))),
    CONSTRAINT question_label_revision_revision_check CHECK ((revision >= 2))
);


--
-- Name: realm_rank; Type: TABLE; Schema: rating; Owner: -
--

CREATE TABLE rating.realm_rank (
    partition_no integer NOT NULL,
    question_id uuid NOT NULL,
    population_id uuid NOT NULL,
    subject_id uuid NOT NULL,
    count bigint NOT NULL,
    mean numeric(12,4) NOT NULL,
    score numeric(12,4) NOT NULL,
    prior_epoch integer NOT NULL,
    prior_generation bigint NOT NULL,
    revision bigint NOT NULL,
    as_of timestamp with time zone NOT NULL,
    CONSTRAINT realm_rank_check CHECK ((partition_no = (((get_byte(uuid_send(subject_id), 10) * 256) + get_byte(uuid_send(subject_id), 11)) >> 4))),
    CONSTRAINT realm_rank_count_check CHECK ((count >= 5)),
    CONSTRAINT realm_rank_partition_no_check CHECK (((partition_no >= 0) AND (partition_no <= 4095)))
);


--
-- Name: realm_rank_delivery; Type: TABLE; Schema: rating; Owner: -
--

CREATE TABLE rating.realm_rank_delivery (
    route integer NOT NULL,
    consumer text NOT NULL,
    key uuid[] NOT NULL,
    epoch bigint NOT NULL,
    "position" bigint NOT NULL,
    revision integer NOT NULL,
    CONSTRAINT realm_rank_delivery_consumer_check CHECK ((consumer = ANY (ARRAY['membership'::text, 'eligibility'::text, 'aggregate'::text]))),
    CONSTRAINT realm_rank_delivery_epoch_check CHECK ((epoch > 0)),
    CONSTRAINT realm_rank_delivery_key_check CHECK ((((cardinality(key) >= 1) AND (cardinality(key) <= 4)) AND (array_position(key, NULL::uuid) IS NULL))),
    CONSTRAINT realm_rank_delivery_position_check CHECK (("position" > 0)),
    CONSTRAINT realm_rank_delivery_revision_check CHECK ((revision >= 0)),
    CONSTRAINT realm_rank_delivery_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: realm_rank_generation; Type: TABLE; Schema: rating; Owner: -
--

CREATE TABLE rating.realm_rank_generation (
    partition_no integer NOT NULL,
    question_id uuid NOT NULL,
    population_id uuid NOT NULL,
    generation bigint NOT NULL,
    CONSTRAINT realm_rank_generation_generation_check CHECK ((generation > 0))
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
    source_alias text DEFAULT 'vndb'::text NOT NULL,
    CONSTRAINT source_statistic_attribution_check CHECK (((char_length(attribution) >= 1) AND (char_length(attribution) <= 2000))),
    CONSTRAINT source_statistic_check CHECK ((scale_max > scale_min)),
    CONSTRAINT source_statistic_check1 CHECK (((mean >= (scale_min)::numeric) AND (mean <= (scale_max)::numeric))),
    CONSTRAINT source_statistic_check2 CHECK ((route = ((get_byte(uuid_send(subject_id), 10) * 256) + get_byte(uuid_send(subject_id), 11)))),
    CONSTRAINT source_statistic_count_check CHECK ((count > 0)),
    CONSTRAINT source_statistic_licence_check CHECK (((char_length(licence) >= 1) AND (char_length(licence) <= 1024))),
    CONSTRAINT source_statistic_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT source_statistic_scale_min_check CHECK ((scale_min >= 0)),
    CONSTRAINT source_statistic_source_alias_check CHECK ((((octet_length(source_alias) >= 1) AND (octet_length(source_alias) <= 32)) AND (source_alias ~ '^[a-z][a-z0-9_-]{0,31}$'::text) AND (source_alias !~ '[^a-z0-9_-]'::text))),
    CONSTRAINT source_statistic_source_check CHECK ((source = 'vndb'::text)),
    CONSTRAINT source_statistic_source_record_id_check CHECK (((char_length(source_record_id) >= 1) AND (char_length(source_record_id) <= 1024)))
);


--
-- Name: subject_home_prior_input; Type: TABLE; Schema: rating; Owner: -
--

CREATE TABLE rating.subject_home_prior_input (
    partition_no integer NOT NULL,
    population_route integer NOT NULL,
    question_id uuid NOT NULL,
    population_id uuid NOT NULL,
    generation bigint NOT NULL,
    epoch integer,
    status text NOT NULL,
    m numeric(12,4),
    c bigint,
    CONSTRAINT subject_home_prior_input_c_check CHECK ((c >= 1)),
    CONSTRAINT subject_home_prior_input_check CHECK ((population_route = ((get_byte(uuid_send(population_id), 10) * 256) + get_byte(uuid_send(population_id), 11)))),
    CONSTRAINT subject_home_prior_input_check1 CHECK ((((status = 'absent'::text) AND (generation = 0) AND (epoch IS NULL) AND (m IS NULL) AND (c IS NULL)) OR ((status = 'inactive'::text) AND (generation > 0) AND (epoch IS NOT NULL) AND (m IS NULL) AND (c IS NULL)) OR ((status = 'active'::text) AND (generation > 0) AND (epoch IS NOT NULL) AND (m IS NOT NULL) AND (c IS NOT NULL)))),
    CONSTRAINT subject_home_prior_input_epoch_check CHECK ((epoch >= 1)),
    CONSTRAINT subject_home_prior_input_generation_check CHECK ((generation >= 0)),
    CONSTRAINT subject_home_prior_input_m_check CHECK (((m >= (0)::numeric) AND (m <= (10)::numeric))),
    CONSTRAINT subject_home_prior_input_partition_no_check CHECK (((partition_no >= 0) AND (partition_no <= 4095))),
    CONSTRAINT subject_home_prior_input_population_route_check CHECK (((population_route >= 0) AND (population_route <= 65535))),
    CONSTRAINT subject_home_prior_input_status_check CHECK ((status = ANY (ARRAY['absent'::text, 'inactive'::text, 'active'::text])))
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
    counted_target uuid,
    counted_revision integer DEFAULT 1 NOT NULL,
    CONSTRAINT vote_check CHECK ((route = ((get_byte(uuid_send(voter_id), 10) * 256) + get_byte(uuid_send(voter_id), 11)))),
    CONSTRAINT vote_counted_revision_check CHECK ((counted_revision >= 1)),
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
-- Name: voter_state; Type: TABLE; Schema: rating; Owner: -
--

CREATE TABLE rating.voter_state (
    route integer NOT NULL,
    voter_id uuid NOT NULL,
    state text DEFAULT 'eligible'::text NOT NULL,
    cursor_question_id uuid,
    cursor_target_id uuid,
    transition_id uuid DEFAULT gen_random_uuid() NOT NULL,
    purge_votes boolean DEFAULT false NOT NULL,
    populations uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    CONSTRAINT voter_state_check CHECK ((route = ((get_byte(uuid_send(voter_id), 10) * 256) + get_byte(uuid_send(voter_id), 11)))),
    CONSTRAINT voter_state_check1 CHECK (((cursor_question_id IS NULL) = (cursor_target_id IS NULL))),
    CONSTRAINT voter_state_check2 CHECK (((state = ANY (ARRAY['leaving'::text, 'returning'::text])) OR (cursor_question_id IS NULL))),
    CONSTRAINT voter_state_check3 CHECK (((NOT purge_votes) OR (state = 'leaving'::text))),
    CONSTRAINT voter_state_populations_check CHECK ((cardinality(populations) <= 101)),
    CONSTRAINT voter_state_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT voter_state_state_check CHECK ((state = ANY (ARRAY['eligible'::text, 'leaving'::text, 'ineligible'::text, 'returning'::text])))
);


--
-- Name: aggregate_component aggregate_component_pkey; Type: CONSTRAINT; Schema: rating; Owner: -
--

ALTER TABLE ONLY rating.aggregate_component
    ADD CONSTRAINT aggregate_component_pkey PRIMARY KEY (route, question_id, population_id, target_id, shard);


--
-- Name: erasure_page erasure_page_pkey; Type: CONSTRAINT; Schema: rating; Owner: -
--

ALTER TABLE ONLY rating.erasure_page
    ADD CONSTRAINT erasure_page_pkey PRIMARY KEY (route, voter_id, page_id);


--
-- Name: identity_repair_receipt identity_repair_receipt_pkey; Type: CONSTRAINT; Schema: rating; Owner: -
--

ALTER TABLE ONLY rating.identity_repair_receipt
    ADD CONSTRAINT identity_repair_receipt_pkey PRIMARY KEY (route, voter_id, page_id);


--
-- Name: identity_work_frame identity_work_frame_pkey; Type: CONSTRAINT; Schema: rating; Owner: -
--

ALTER TABLE ONLY rating.identity_work_frame
    ADD CONSTRAINT identity_work_frame_pkey PRIMARY KEY (route, voter_id);


--
-- Name: population_pending population_pending_pkey; Type: CONSTRAINT; Schema: rating; Owner: -
--

ALTER TABLE ONLY rating.population_pending
    ADD CONSTRAINT population_pending_pkey PRIMARY KEY (route, population_id);


--
-- Name: population_prior_epoch population_prior_epoch_pkey; Type: CONSTRAINT; Schema: rating; Owner: -
--

ALTER TABLE ONLY rating.population_prior_epoch
    ADD CONSTRAINT population_prior_epoch_pkey PRIMARY KEY (route, question_id, population_id);


--
-- Name: population_prior_republish population_prior_republish_pkey; Type: CONSTRAINT; Schema: rating; Owner: -
--

ALTER TABLE ONLY rating.population_prior_republish
    ADD CONSTRAINT population_prior_republish_pkey PRIMARY KEY (route, question_id, population_id);


--
-- Name: population_total_clock population_total_clock_pkey; Type: CONSTRAINT; Schema: rating; Owner: -
--

ALTER TABLE ONLY rating.population_total_clock
    ADD CONSTRAINT population_total_clock_pkey PRIMARY KEY (partition_no);


--
-- Name: population_total_component population_total_component_pkey; Type: CONSTRAINT; Schema: rating; Owner: -
--

ALTER TABLE ONLY rating.population_total_component
    ADD CONSTRAINT population_total_component_pkey PRIMARY KEY (route, question_id, population_id, shard);


--
-- Name: population_total_delivery population_total_delivery_pkey; Type: CONSTRAINT; Schema: rating; Owner: -
--

ALTER TABLE ONLY rating.population_total_delivery
    ADD CONSTRAINT population_total_delivery_pkey PRIMARY KEY (partition_no, population_id, serial);


--
-- Name: population_total_inbox population_total_inbox_pkey; Type: CONSTRAINT; Schema: rating; Owner: -
--

ALTER TABLE ONLY rating.population_total_inbox
    ADD CONSTRAINT population_total_inbox_pkey PRIMARY KEY (route, population_id, source_partition, serial);


--
-- Name: population_total_received population_total_received_pkey; Type: CONSTRAINT; Schema: rating; Owner: -
--

ALTER TABLE ONLY rating.population_total_received
    ADD CONSTRAINT population_total_received_pkey PRIMARY KEY (route, population_id, source_partition);


--
-- Name: population_total_source population_total_source_pkey; Type: CONSTRAINT; Schema: rating; Owner: -
--

ALTER TABLE ONLY rating.population_total_source
    ADD CONSTRAINT population_total_source_pkey PRIMARY KEY (partition_no, population_id);


--
-- Name: population_vote population_vote_pkey; Type: CONSTRAINT; Schema: rating; Owner: -
--

ALTER TABLE ONLY rating.population_vote
    ADD CONSTRAINT population_vote_pkey PRIMARY KEY (route, question_id, population_id, target_id, voter_id);


--
-- Name: population_vote_removal population_vote_removal_pkey; Type: CONSTRAINT; Schema: rating; Owner: -
--

ALTER TABLE ONLY rating.population_vote_removal
    ADD CONSTRAINT population_vote_removal_pkey PRIMARY KEY (route, question_id, population_id, target_id, voter_id);


--
-- Name: public_figure public_figure_pkey; Type: CONSTRAINT; Schema: rating; Owner: -
--

ALTER TABLE ONLY rating.public_figure
    ADD CONSTRAINT public_figure_pkey PRIMARY KEY (route, question_id, population_id, subject_id);


--
-- Name: question_label_head question_label_head_pkey; Type: CONSTRAINT; Schema: rating; Owner: -
--

ALTER TABLE ONLY rating.question_label_head
    ADD CONSTRAINT question_label_head_pkey PRIMARY KEY (question_id);


--
-- Name: question_label_revision question_label_revision_pkey; Type: CONSTRAINT; Schema: rating; Owner: -
--

ALTER TABLE ONLY rating.question_label_revision
    ADD CONSTRAINT question_label_revision_pkey PRIMARY KEY (question_id, revision);


--
-- Name: question question_pkey; Type: CONSTRAINT; Schema: rating; Owner: -
--

ALTER TABLE ONLY rating.question
    ADD CONSTRAINT question_pkey PRIMARY KEY (id);


--
-- Name: realm_rank_delivery realm_rank_delivery_pkey; Type: CONSTRAINT; Schema: rating; Owner: -
--

ALTER TABLE ONLY rating.realm_rank_delivery
    ADD CONSTRAINT realm_rank_delivery_pkey PRIMARY KEY (route, consumer, key);


--
-- Name: realm_rank_generation realm_rank_generation_pkey; Type: CONSTRAINT; Schema: rating; Owner: -
--

ALTER TABLE ONLY rating.realm_rank_generation
    ADD CONSTRAINT realm_rank_generation_pkey PRIMARY KEY (partition_no, question_id, population_id);


--
-- Name: realm_rank realm_rank_pkey; Type: CONSTRAINT; Schema: rating; Owner: -
--

ALTER TABLE ONLY rating.realm_rank
    ADD CONSTRAINT realm_rank_pkey PRIMARY KEY (partition_no, question_id, population_id, subject_id);


--
-- Name: source_statistic source_statistic_pkey; Type: CONSTRAINT; Schema: rating; Owner: -
--

ALTER TABLE ONLY rating.source_statistic
    ADD CONSTRAINT source_statistic_pkey PRIMARY KEY (route, subject_id, source);


--
-- Name: subject_home_prior_input subject_home_prior_input_pkey; Type: CONSTRAINT; Schema: rating; Owner: -
--

ALTER TABLE ONLY rating.subject_home_prior_input
    ADD CONSTRAINT subject_home_prior_input_pkey PRIMARY KEY (partition_no, population_route, question_id, population_id);


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
-- Name: voter_state voter_state_pkey; Type: CONSTRAINT; Schema: rating; Owner: -
--

ALTER TABLE ONLY rating.voter_state
    ADD CONSTRAINT voter_state_pkey PRIMARY KEY (route, voter_id);


--
-- Name: aggregate_component_population_subject_idx; Type: INDEX; Schema: rating; Owner: -
--

CREATE INDEX aggregate_component_population_subject_idx ON rating.aggregate_component USING btree (question_id, population_id, target_id, route, shard) WHERE (count > 0);


--
-- Name: aggregate_component_target_population_idx; Type: INDEX; Schema: rating; Owner: -
--

CREATE INDEX aggregate_component_target_population_idx ON rating.aggregate_component USING btree (route, question_id, target_id, population_id, shard) WHERE (count > 0);


--
-- Name: erasure_page_pending_idx; Type: INDEX; Schema: rating; Owner: -
--

CREATE INDEX erasure_page_pending_idx ON rating.erasure_page USING btree (route, voter_id, page_id) WHERE (NOT terminal);


--
-- Name: population_total_delivery_pending_idx; Type: INDEX; Schema: rating; Owner: -
--

CREATE INDEX population_total_delivery_pending_idx ON rating.population_total_delivery USING btree (partition_no, population_id, serial) WHERE pending;


--
-- Name: population_total_epoch_check_idx; Type: INDEX; Schema: rating; Owner: -
--

CREATE INDEX population_total_epoch_check_idx ON rating.population_total_component USING btree (question_id, population_id, shard) WHERE needs_epoch_check;


--
-- Name: population_vote_counted_idx; Type: INDEX; Schema: rating; Owner: -
--

CREATE INDEX population_vote_counted_idx ON rating.population_vote USING btree (route, question_id, population_id, target_id, counting_key, at DESC, voter_id) WHERE (units IS NOT NULL);


--
-- Name: population_vote_target_page_idx; Type: INDEX; Schema: rating; Owner: -
--

CREATE INDEX population_vote_target_page_idx ON rating.population_vote USING btree (route, population_id, target_id, question_id, voter_id);


--
-- Name: population_vote_target_voter_page_idx; Type: INDEX; Schema: rating; Owner: -
--

CREATE INDEX population_vote_target_voter_page_idx ON rating.population_vote USING btree (route, population_id, target_id, voter_id, question_id);


--
-- Name: public_figure_pending_idx; Type: INDEX; Schema: rating; Owner: -
--

CREATE INDEX public_figure_pending_idx ON rating.public_figure USING btree (partition_no, route, question_id, population_id, subject_id) WHERE (pending_position IS NOT NULL);


--
-- Name: public_figure_population_subject_idx; Type: INDEX; Schema: rating; Owner: -
--

CREATE INDEX public_figure_population_subject_idx ON rating.public_figure USING btree (partition_no, question_id, population_id, subject_id) WHERE (revision > 0);


--
-- Name: public_figure_prior_pending_idx; Type: INDEX; Schema: rating; Owner: -
--

CREATE INDEX public_figure_prior_pending_idx ON rating.public_figure USING btree (partition_no, route, question_id, population_id, subject_id) WHERE (pending_prior_generation IS NOT NULL);


--
-- Name: question_realm_directory_idx; Type: INDEX; Schema: rating; Owner: -
--

CREATE INDEX question_realm_directory_idx ON rating.question USING btree (realm_id, id);


--
-- Name: realm_rank_score_idx; Type: INDEX; Schema: rating; Owner: -
--

CREATE INDEX realm_rank_score_idx ON rating.realm_rank USING btree (partition_no, question_id, population_id, prior_generation, score DESC, subject_id DESC);


--
-- Name: vote_counted_target_idx; Type: INDEX; Schema: rating; Owner: -
--

CREATE UNIQUE INDEX vote_counted_target_idx ON rating.vote USING btree (route, voter_id, question_id, counted_target) WHERE (counted_target IS NOT NULL);


--
-- Name: voter_realm_capped_idx; Type: INDEX; Schema: rating; Owner: -
--

CREATE INDEX voter_realm_capped_idx ON rating.voter_realm USING btree (route, voter_id, realm_id) WHERE (state <> 'uncounted'::text);


--
-- Name: voter_realm_waiting_idx; Type: INDEX; Schema: rating; Owner: -
--

CREATE INDEX voter_realm_waiting_idx ON rating.voter_realm USING btree (route, voter_id, joined_at, realm_id) WHERE (state = 'uncounted'::text);


--
-- Name: population_total_component population_total_delivery_writer; Type: TRIGGER; Schema: rating; Owner: -
--

CREATE TRIGGER population_total_delivery_writer BEFORE INSERT OR UPDATE ON rating.population_total_component FOR EACH ROW EXECUTE FUNCTION rating.require_population_total_delivery();

ALTER TABLE rating.population_total_component ENABLE ALWAYS TRIGGER population_total_delivery_writer;


--
-- Name: public_figure public_figure_realm_rank; Type: TRIGGER; Schema: rating; Owner: -
--

CREATE TRIGGER public_figure_realm_rank AFTER INSERT OR DELETE OR UPDATE ON rating.public_figure FOR EACH ROW EXECUTE FUNCTION rating.publish_realm_rank();


--
-- Name: question question_definition_immutable; Type: TRIGGER; Schema: rating; Owner: -
--

CREATE TRIGGER question_definition_immutable BEFORE UPDATE ON rating.question FOR EACH ROW EXECUTE FUNCTION rating.keep_question_definition();


--
-- Name: question question_label_initial; Type: TRIGGER; Schema: rating; Owner: -
--

CREATE TRIGGER question_label_initial AFTER INSERT ON rating.question FOR EACH ROW EXECUTE FUNCTION rating.initialize_question_label();


--
-- Name: question_label_revision question_label_revision_immutable; Type: TRIGGER; Schema: rating; Owner: -
--

CREATE TRIGGER question_label_revision_immutable BEFORE UPDATE ON rating.question_label_revision FOR EACH ROW EXECUTE FUNCTION rating.keep_question_label_revision();


--
-- Name: vote vote_initialize_counting; Type: TRIGGER; Schema: rating; Owner: -
--

CREATE TRIGGER vote_initialize_counting BEFORE INSERT ON rating.vote FOR EACH ROW EXECUTE FUNCTION rating.initialize_vote_counting();


--
-- Name: aggregate_component aggregate_component_question_id_fkey; Type: FK CONSTRAINT; Schema: rating; Owner: -
--

ALTER TABLE ONLY rating.aggregate_component
    ADD CONSTRAINT aggregate_component_question_id_fkey FOREIGN KEY (question_id) REFERENCES rating.question(id);


--
-- Name: population_prior_epoch population_prior_epoch_question_id_fkey; Type: FK CONSTRAINT; Schema: rating; Owner: -
--

ALTER TABLE ONLY rating.population_prior_epoch
    ADD CONSTRAINT population_prior_epoch_question_id_fkey FOREIGN KEY (question_id) REFERENCES rating.question(id);


--
-- Name: population_prior_republish population_prior_republish_question_id_fkey; Type: FK CONSTRAINT; Schema: rating; Owner: -
--

ALTER TABLE ONLY rating.population_prior_republish
    ADD CONSTRAINT population_prior_republish_question_id_fkey FOREIGN KEY (question_id) REFERENCES rating.question(id);


--
-- Name: population_total_component population_total_component_question_id_fkey; Type: FK CONSTRAINT; Schema: rating; Owner: -
--

ALTER TABLE ONLY rating.population_total_component
    ADD CONSTRAINT population_total_component_question_id_fkey FOREIGN KEY (question_id) REFERENCES rating.question(id);


--
-- Name: population_vote population_vote_question_id_fkey; Type: FK CONSTRAINT; Schema: rating; Owner: -
--

ALTER TABLE ONLY rating.population_vote
    ADD CONSTRAINT population_vote_question_id_fkey FOREIGN KEY (question_id) REFERENCES rating.question(id);


--
-- Name: public_figure public_figure_question_id_fkey; Type: FK CONSTRAINT; Schema: rating; Owner: -
--

ALTER TABLE ONLY rating.public_figure
    ADD CONSTRAINT public_figure_question_id_fkey FOREIGN KEY (question_id) REFERENCES rating.question(id);


--
-- Name: question_label_head question_label_head_question_id_fkey; Type: FK CONSTRAINT; Schema: rating; Owner: -
--

ALTER TABLE ONLY rating.question_label_head
    ADD CONSTRAINT question_label_head_question_id_fkey FOREIGN KEY (question_id) REFERENCES rating.question(id) ON DELETE CASCADE;


--
-- Name: question_label_revision question_label_revision_question_id_fkey; Type: FK CONSTRAINT; Schema: rating; Owner: -
--

ALTER TABLE ONLY rating.question_label_revision
    ADD CONSTRAINT question_label_revision_question_id_fkey FOREIGN KEY (question_id) REFERENCES rating.question(id) ON DELETE CASCADE;


--
-- Name: source_statistic source_statistic_route_subject_id_fkey; Type: FK CONSTRAINT; Schema: rating; Owner: -
--

ALTER TABLE ONLY rating.source_statistic
    ADD CONSTRAINT source_statistic_route_subject_id_fkey FOREIGN KEY (route, subject_id) REFERENCES semantic.subject(route, subject_id);


--
-- Name: subject_home_prior_input subject_home_prior_input_question_id_fkey; Type: FK CONSTRAINT; Schema: rating; Owner: -
--

ALTER TABLE ONLY rating.subject_home_prior_input
    ADD CONSTRAINT subject_home_prior_input_question_id_fkey FOREIGN KEY (question_id) REFERENCES rating.question(id);


--
-- Name: vote vote_question_id_fkey; Type: FK CONSTRAINT; Schema: rating; Owner: -
--

ALTER TABLE ONLY rating.vote
    ADD CONSTRAINT vote_question_id_fkey FOREIGN KEY (question_id) REFERENCES rating.question(id);


--
-- PostgreSQL database dump complete
--


