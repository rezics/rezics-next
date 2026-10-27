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
-- Name: collection; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.collection (
    route integer NOT NULL,
    collection_id uuid NOT NULL,
    curator_account_id uuid NOT NULL,
    title text NOT NULL,
    description text,
    visibility text NOT NULL,
    state text NOT NULL,
    revision integer NOT NULL,
    member_count integer DEFAULT 0 NOT NULL,
    order_epoch integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    transaction_id uuid NOT NULL,
    CONSTRAINT collection_check CHECK ((route = ((get_byte(uuid_send(collection_id), 10) * 256) + get_byte(uuid_send(collection_id), 11)))),
    CONSTRAINT collection_check1 CHECK ((route = ((get_byte(uuid_send(curator_account_id), 10) * 256) + get_byte(uuid_send(curator_account_id), 11)))),
    CONSTRAINT collection_description_check CHECK (((description IS NULL) OR (char_length(description) <= 2000))),
    CONSTRAINT collection_member_count_check CHECK (((member_count >= 0) AND (member_count <= 5000))),
    CONSTRAINT collection_order_epoch_check CHECK ((order_epoch >= 0)),
    CONSTRAINT collection_revision_check CHECK ((revision >= 1)),
    CONSTRAINT collection_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT collection_state_check CHECK ((state = ANY (ARRAY['active'::text, 'deleted'::text]))),
    CONSTRAINT collection_title_check CHECK (((char_length(title) >= 1) AND (char_length(title) <= 200))),
    CONSTRAINT collection_visibility_check CHECK ((visibility = ANY (ARRAY['private'::text, 'unlisted'::text, 'public'::text])))
);


--
-- Name: collection_member; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.collection_member (
    route integer NOT NULL,
    collection_id uuid NOT NULL,
    member_id uuid NOT NULL,
    subject_id uuid NOT NULL,
    note text,
    ordinal_key text NOT NULL COLLATE pg_catalog."C",
    added_at timestamp with time zone NOT NULL,
    transaction_id uuid NOT NULL,
    CONSTRAINT collection_member_check CHECK ((route = ((get_byte(uuid_send(collection_id), 10) * 256) + get_byte(uuid_send(collection_id), 11)))),
    CONSTRAINT collection_member_check1 CHECK ((route = ((get_byte(uuid_send(member_id), 10) * 256) + get_byte(uuid_send(member_id), 11)))),
    CONSTRAINT collection_member_note_check CHECK (((note IS NULL) OR (char_length(note) <= 1000))),
    CONSTRAINT collection_member_ordinal_key_check CHECK (((char_length(ordinal_key) >= 1) AND (char_length(ordinal_key) <= 48))),
    CONSTRAINT collection_member_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: copy; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.copy (
    route integer NOT NULL,
    copy_id uuid NOT NULL,
    account_id uuid NOT NULL,
    subject_id uuid NOT NULL,
    status text NOT NULL,
    location text,
    source text,
    acquired_on date,
    disposed_on date,
    note text,
    revision integer NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    transaction_id uuid NOT NULL,
    CONSTRAINT copy_check CHECK ((route = ((get_byte(uuid_send(copy_id), 10) * 256) + get_byte(uuid_send(copy_id), 11)))),
    CONSTRAINT copy_check1 CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT copy_location_check CHECK (((location IS NULL) OR (char_length(location) <= 200))),
    CONSTRAINT copy_note_check CHECK (((note IS NULL) OR (char_length(note) <= 1000))),
    CONSTRAINT copy_revision_check CHECK ((revision >= 1)),
    CONSTRAINT copy_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT copy_source_check CHECK (((source IS NULL) OR (char_length(source) <= 200))),
    CONSTRAINT copy_status_check CHECK ((status = ANY (ARRAY['ordered'::text, 'owned'::text, 'lent'::text, 'disposed'::text])))
);


--
-- Name: entry; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.entry (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    subject_id uuid NOT NULL,
    requested_subject_id uuid,
    state text NOT NULL,
    revision integer NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    transaction_id uuid NOT NULL,
    activity_at timestamp with time zone,
    finished_at timestamp with time zone,
    type_id uuid,
    type_source_id uuid,
    type_source_partition integer,
    type_source_epoch integer,
    type_source_position bigint,
    incarnation_id uuid,
    CONSTRAINT entry_check CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT entry_revision_check CHECK ((revision >= 1)),
    CONSTRAINT entry_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT entry_state_check CHECK ((state = ANY (ARRAY['planned'::text, 'in_progress'::text, 'completed'::text, 'paused'::text, 'dropped'::text]))),
    CONSTRAINT entry_type_observation_check CHECK ((((type_id IS NULL) AND (type_source_id IS NULL) AND (type_source_partition IS NULL) AND (type_source_epoch IS NULL) AND (type_source_position IS NULL)) OR ((type_id IS NOT NULL) AND (type_source_id IS NOT NULL) AND (type_source_partition IS NOT NULL) AND (type_source_epoch IS NOT NULL) AND (type_source_position IS NOT NULL) AND ((type_source_partition >= 0) AND (type_source_partition <= 4095)) AND (type_source_epoch >= 1) AND (type_source_position >= 0) AND (type_source_partition = (((get_byte(uuid_send(type_source_id), 10) * 256) + get_byte(uuid_send(type_source_id), 11)) >> 4)))))
);


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
-- Name: progress_change; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.progress_change (
    route integer NOT NULL,
    session_id uuid NOT NULL,
    change_no integer NOT NULL,
    intent jsonb NOT NULL,
    recorded_at timestamp with time zone NOT NULL,
    transaction_id uuid NOT NULL,
    CONSTRAINT progress_change_change_no_check CHECK ((change_no >= 1)),
    CONSTRAINT progress_change_check CHECK ((route = ((get_byte(uuid_send(session_id), 10) * 256) + get_byte(uuid_send(session_id), 11)))),
    CONSTRAINT progress_change_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: progress_head; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.progress_head (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    subject_id uuid NOT NULL,
    last_changed_at timestamp with time zone,
    last_completed_at timestamp with time zone,
    CONSTRAINT progress_head_check CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT progress_head_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: progress_session; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.progress_session (
    route integer NOT NULL,
    session_id uuid NOT NULL,
    account_id uuid NOT NULL,
    subject_id uuid NOT NULL,
    version_subject_id uuid,
    mode text NOT NULL,
    unit text NOT NULL,
    total numeric,
    amount numeric,
    locator text,
    "position" numeric,
    completed_unit_count integer NOT NULL,
    state text NOT NULL,
    revision integer NOT NULL,
    started_at timestamp with time zone NOT NULL,
    completed_at timestamp with time zone,
    transaction_id uuid NOT NULL,
    last_changed_at timestamp with time zone,
    CONSTRAINT progress_session_amount_check CHECK (((amount IS NULL) OR (amount >= (0)::numeric))),
    CONSTRAINT progress_session_check CHECK ((route = ((get_byte(uuid_send(session_id), 10) * 256) + get_byte(uuid_send(session_id), 11)))),
    CONSTRAINT progress_session_check1 CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT progress_session_check2 CHECK (((unit <> 'percent'::text) OR (((amount IS NULL) OR (amount <= (100)::numeric)) AND ((total IS NULL) OR (total <= (100)::numeric))))),
    CONSTRAINT progress_session_check3 CHECK (((state = 'completed'::text) = (completed_at IS NOT NULL))),
    CONSTRAINT progress_session_check4 CHECK ((((mode = 'scalar_amount'::text) AND (locator IS NULL) AND ("position" IS NULL) AND (completed_unit_count = 0)) OR ((mode = 'cursor_position'::text) AND (amount IS NULL) AND (total IS NULL) AND (completed_unit_count = 0) AND (((locator IS NULL) AND ("position" IS NULL)) OR ((locator IS NOT NULL) AND ("position" IS NOT NULL)))) OR ((mode = 'completed_units'::text) AND (amount IS NULL) AND (total IS NULL) AND (locator IS NULL) AND ("position" IS NULL)))),
    CONSTRAINT progress_session_completed_unit_count_check CHECK (((completed_unit_count >= 0) AND (completed_unit_count <= 20000))),
    CONSTRAINT progress_session_locator_check CHECK (((locator IS NULL) OR ((char_length(locator) >= 1) AND (char_length(locator) <= 256)))),
    CONSTRAINT progress_session_mode_check CHECK ((mode = ANY (ARRAY['scalar_amount'::text, 'cursor_position'::text, 'completed_units'::text]))),
    CONSTRAINT progress_session_position_check CHECK ((("position" IS NULL) OR ("position" >= (0)::numeric))),
    CONSTRAINT progress_session_revision_check CHECK ((revision >= 1)),
    CONSTRAINT progress_session_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT progress_session_state_check CHECK ((state = ANY (ARRAY['active'::text, 'completed'::text, 'abandoned'::text]))),
    CONSTRAINT progress_session_total_check CHECK (((total IS NULL) OR (total >= (0)::numeric))),
    CONSTRAINT progress_session_unit_check CHECK ((unit = ANY (ARRAY['page'::text, 'chapter'::text, 'episode'::text, 'volume'::text, 'minute'::text, 'percent'::text])))
);


--
-- Name: progress_unit; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.progress_unit (
    route integer NOT NULL,
    session_id uuid NOT NULL,
    unit_id text NOT NULL,
    added_at timestamp with time zone NOT NULL,
    CONSTRAINT progress_unit_check CHECK ((route = ((get_byte(uuid_send(session_id), 10) * 256) + get_byte(uuid_send(session_id), 11)))),
    CONSTRAINT progress_unit_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT progress_unit_unit_id_check CHECK (((char_length(unit_id) >= 1) AND (char_length(unit_id) <= 128)))
);


--
-- Name: published_log; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.published_log (
    route integer NOT NULL,
    log_id uuid NOT NULL,
    account_id uuid NOT NULL,
    session_id uuid NOT NULL,
    subject_id uuid NOT NULL,
    session_state text NOT NULL,
    started_at timestamp with time zone NOT NULL,
    completed_at timestamp with time zone,
    note text,
    published_at timestamp with time zone NOT NULL,
    transaction_id uuid NOT NULL,
    CONSTRAINT published_log_check CHECK ((route = ((get_byte(uuid_send(log_id), 10) * 256) + get_byte(uuid_send(log_id), 11)))),
    CONSTRAINT published_log_check1 CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT published_log_check2 CHECK ((route = ((get_byte(uuid_send(session_id), 10) * 256) + get_byte(uuid_send(session_id), 11)))),
    CONSTRAINT published_log_check3 CHECK (((session_state = 'completed'::text) = (completed_at IS NOT NULL))),
    CONSTRAINT published_log_note_check CHECK (((note IS NULL) OR ((char_length(note) >= 0) AND (char_length(note) <= 1000)))),
    CONSTRAINT published_log_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT published_log_session_state_check CHECK ((session_state = ANY (ARRAY['active'::text, 'completed'::text, 'abandoned'::text])))
);


--
-- Name: shelf_count; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.shelf_count (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    bucket text NOT NULL,
    type_id uuid NOT NULL,
    n bigint NOT NULL,
    CONSTRAINT shelf_count_bucket_check CHECK ((bucket = ANY (ARRAY['planned'::text, 'in_progress'::text, 'completed'::text, 'paused'::text, 'dropped'::text, 'all'::text, 'collections'::text]))),
    CONSTRAINT shelf_count_check CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT shelf_count_check1 CHECK (((bucket <> 'collections'::text) OR (type_id = '00000000-0000-0000-0000-000000000000'::uuid))),
    CONSTRAINT shelf_count_n_check CHECK ((n >= 0)),
    CONSTRAINT shelf_count_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: subject_collection; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.subject_collection (
    route integer NOT NULL,
    subject_id uuid NOT NULL,
    collection_id uuid NOT NULL,
    collection_route integer NOT NULL,
    multiplicity integer NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    transaction_id uuid NOT NULL,
    CONSTRAINT subject_collection_check CHECK ((route = ((get_byte(uuid_send(subject_id), 10) * 256) + get_byte(uuid_send(subject_id), 11)))),
    CONSTRAINT subject_collection_check1 CHECK ((collection_route = ((get_byte(uuid_send(collection_id), 10) * 256) + get_byte(uuid_send(collection_id), 11)))),
    CONSTRAINT subject_collection_collection_route_check CHECK (((collection_route >= 0) AND (collection_route <= 65535))),
    CONSTRAINT subject_collection_multiplicity_check CHECK ((multiplicity >= 1)),
    CONSTRAINT subject_collection_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: subject_listing; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.subject_listing (
    route integer NOT NULL,
    subject_id uuid NOT NULL,
    public_collection_count integer NOT NULL,
    revision integer NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    transaction_id uuid NOT NULL,
    CONSTRAINT subject_listing_check CHECK ((route = ((get_byte(uuid_send(subject_id), 10) * 256) + get_byte(uuid_send(subject_id), 11)))),
    CONSTRAINT subject_listing_public_collection_count_check CHECK ((public_collection_count >= 0)),
    CONSTRAINT subject_listing_revision_check CHECK ((revision >= 1)),
    CONSTRAINT subject_listing_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: collection_member collection_member_ordinal_key; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.collection_member
    ADD CONSTRAINT collection_member_ordinal_key UNIQUE (route, collection_id, ordinal_key) DEFERRABLE;


--
-- Name: collection_member collection_member_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.collection_member
    ADD CONSTRAINT collection_member_pkey PRIMARY KEY (route, collection_id, member_id);


--
-- Name: collection collection_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.collection
    ADD CONSTRAINT collection_pkey PRIMARY KEY (route, collection_id);


--
-- Name: copy copy_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.copy
    ADD CONSTRAINT copy_pkey PRIMARY KEY (route, copy_id);


--
-- Name: entry entry_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.entry
    ADD CONSTRAINT entry_pkey PRIMARY KEY (route, account_id, subject_id);


--
-- Name: follow follow_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.follow
    ADD CONSTRAINT follow_pkey PRIMARY KEY (route, account_id, target_id);


--
-- Name: progress_change progress_change_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.progress_change
    ADD CONSTRAINT progress_change_pkey PRIMARY KEY (route, session_id, change_no);


--
-- Name: progress_head progress_head_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.progress_head
    ADD CONSTRAINT progress_head_pkey PRIMARY KEY (route, account_id, subject_id);


--
-- Name: progress_session progress_session_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.progress_session
    ADD CONSTRAINT progress_session_pkey PRIMARY KEY (route, session_id);


--
-- Name: progress_unit progress_unit_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.progress_unit
    ADD CONSTRAINT progress_unit_pkey PRIMARY KEY (route, session_id, unit_id);


--
-- Name: published_log published_log_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.published_log
    ADD CONSTRAINT published_log_pkey PRIMARY KEY (route, log_id);


--
-- Name: shelf_count shelf_count_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.shelf_count
    ADD CONSTRAINT shelf_count_pkey PRIMARY KEY (route, account_id, bucket, type_id);


--
-- Name: subject_collection subject_collection_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.subject_collection
    ADD CONSTRAINT subject_collection_pkey PRIMARY KEY (route, subject_id, collection_id);


--
-- Name: subject_listing subject_listing_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.subject_listing
    ADD CONSTRAINT subject_listing_pkey PRIMARY KEY (route, subject_id);


--
-- Name: collection_curator_listing; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX collection_curator_listing ON library.collection USING btree (route, curator_account_id, collection_id);


--
-- Name: collection_curator_page; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX collection_curator_page ON library.collection USING btree (route, curator_account_id, updated_at DESC, collection_id DESC) WHERE (state = 'active'::text);


--
-- Name: collection_curator_public_page; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX collection_curator_public_page ON library.collection USING btree (route, curator_account_id, updated_at DESC, collection_id DESC) WHERE ((state = 'active'::text) AND (visibility = 'public'::text));


--
-- Name: collection_member_subject; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX collection_member_subject ON library.collection_member USING btree (route, collection_id, subject_id);


--
-- Name: collection_sitemap_public_page; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX collection_sitemap_public_page ON library.collection USING btree (route, collection_id) INCLUDE (updated_at) WHERE ((state = 'active'::text) AND (visibility = 'public'::text));


--
-- Name: copy_account_created; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX copy_account_created ON library.copy USING btree (route, account_id, created_at, copy_id);


--
-- Name: copy_account_subject_created; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX copy_account_subject_created ON library.copy USING btree (route, account_id, subject_id, created_at, copy_id);


--
-- Name: entry_account_state; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX entry_account_state ON library.entry USING btree (route, account_id, state, updated_at DESC, subject_id);


--
-- Name: entry_account_updated; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX entry_account_updated ON library.entry USING btree (route, account_id, updated_at DESC, subject_id);


--
-- Name: entry_shelf_activity; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX entry_shelf_activity ON library.entry USING btree (route, account_id, activity_at DESC, subject_id);


--
-- Name: entry_shelf_activity_state; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX entry_shelf_activity_state ON library.entry USING btree (route, account_id, state, activity_at DESC, subject_id);


--
-- Name: entry_shelf_activity_state_type; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX entry_shelf_activity_state_type ON library.entry USING btree (route, account_id, state, type_id, activity_at DESC, subject_id);


--
-- Name: entry_shelf_activity_type; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX entry_shelf_activity_type ON library.entry USING btree (route, account_id, type_id, activity_at DESC, subject_id);


--
-- Name: entry_shelf_created; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX entry_shelf_created ON library.entry USING btree (route, account_id, created_at DESC, subject_id);


--
-- Name: entry_shelf_created_state; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX entry_shelf_created_state ON library.entry USING btree (route, account_id, state, created_at DESC, subject_id);


--
-- Name: entry_shelf_created_state_type; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX entry_shelf_created_state_type ON library.entry USING btree (route, account_id, state, type_id, created_at DESC, subject_id);


--
-- Name: entry_shelf_created_type; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX entry_shelf_created_type ON library.entry USING btree (route, account_id, type_id, created_at DESC, subject_id);


--
-- Name: entry_shelf_finished; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX entry_shelf_finished ON library.entry USING btree (route, account_id, finished_at DESC NULLS LAST, subject_id);


--
-- Name: entry_shelf_finished_state; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX entry_shelf_finished_state ON library.entry USING btree (route, account_id, state, finished_at DESC NULLS LAST, subject_id);


--
-- Name: entry_shelf_finished_state_type; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX entry_shelf_finished_state_type ON library.entry USING btree (route, account_id, state, type_id, finished_at DESC NULLS LAST, subject_id);


--
-- Name: entry_shelf_finished_type; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX entry_shelf_finished_type ON library.entry USING btree (route, account_id, type_id, finished_at DESC NULLS LAST, subject_id);


--
-- Name: entry_type_source; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX entry_type_source ON library.entry USING btree (type_source_id, route, account_id, subject_id);


--
-- Name: follow_account_page; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX follow_account_page ON library.follow USING btree (route, account_id, state, updated_at DESC, target_id);


--
-- Name: progress_session_account_subject; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX progress_session_account_subject ON library.progress_session USING btree (route, account_id, subject_id, started_at DESC, session_id);


--
-- Name: progress_session_active; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX progress_session_active ON library.progress_session USING btree (route, account_id, subject_id, last_changed_at DESC, session_id) WHERE (state = 'active'::text);


--
-- Name: published_log_account_page; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX published_log_account_page ON library.published_log USING btree (route, account_id, published_at DESC, log_id);


--
-- Name: shelf_count_types; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX shelf_count_types ON library.shelf_count USING btree (route, account_id, type_id) WHERE ((bucket = 'all'::text) AND (type_id <> '00000000-0000-0000-0000-000000000000'::uuid) AND (n > 0));


--
-- Name: follow follow_target_type_immutable; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER follow_target_type_immutable BEFORE UPDATE OF target_type ON library.follow FOR EACH ROW EXECUTE FUNCTION library.guard_follow_target_type();


--
-- Name: collection_member collection_member_route_collection_id_fkey; Type: FK CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.collection_member
    ADD CONSTRAINT collection_member_route_collection_id_fkey FOREIGN KEY (route, collection_id) REFERENCES library.collection(route, collection_id);


--
-- Name: progress_change progress_change_route_session_id_fkey; Type: FK CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.progress_change
    ADD CONSTRAINT progress_change_route_session_id_fkey FOREIGN KEY (route, session_id) REFERENCES library.progress_session(route, session_id);


--
-- Name: progress_unit progress_unit_route_session_id_fkey; Type: FK CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.progress_unit
    ADD CONSTRAINT progress_unit_route_session_id_fkey FOREIGN KEY (route, session_id) REFERENCES library.progress_session(route, session_id);


--
-- PostgreSQL database dump complete
--


