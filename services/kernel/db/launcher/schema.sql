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
-- Name: launcher; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA launcher;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: package; Type: TABLE; Schema: launcher; Owner: -
--

CREATE TABLE launcher.package (
    id text NOT NULL COLLATE pg_catalog."C",
    kind text NOT NULL,
    publisher text NOT NULL,
    title text NOT NULL,
    title_key text NOT NULL COLLATE pg_catalog."C",
    summary text NOT NULL,
    subject_id uuid,
    live_count bigint NOT NULL,
    CONSTRAINT package_kind_check CHECK ((kind = ANY (ARRAY['overlay-panel'::text, 'minecraft-mod'::text]))),
    CONSTRAINT package_live_count_check CHECK ((live_count >= 0))
);


--
-- Name: release; Type: TABLE; Schema: launcher; Owner: -
--

CREATE TABLE launcher.release (
    package_id text NOT NULL COLLATE pg_catalog."C",
    id text NOT NULL COLLATE pg_catalog."C",
    version text NOT NULL,
    compatibility jsonb NOT NULL,
    artifact_url text NOT NULL,
    artifact_size bigint NOT NULL,
    artifact_sha256 text NOT NULL,
    requirements jsonb NOT NULL,
    published_at timestamp(3) with time zone NOT NULL,
    withdrawn_at timestamp with time zone,
    CONSTRAINT release_artifact_sha256_check CHECK ((artifact_sha256 ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT release_artifact_size_check CHECK (((artifact_size >= 1) AND (artifact_size <= '2147483648'::bigint)))
);


--
-- Name: package package_pkey; Type: CONSTRAINT; Schema: launcher; Owner: -
--

ALTER TABLE ONLY launcher.package
    ADD CONSTRAINT package_pkey PRIMARY KEY (id);


--
-- Name: release release_package_id_version_key; Type: CONSTRAINT; Schema: launcher; Owner: -
--

ALTER TABLE ONLY launcher.release
    ADD CONSTRAINT release_package_id_version_key UNIQUE (package_id, version);


--
-- Name: release release_pkey; Type: CONSTRAINT; Schema: launcher; Owner: -
--

ALTER TABLE ONLY launcher.release
    ADD CONSTRAINT release_pkey PRIMARY KEY (package_id, id);


--
-- Name: package_kind_visible; Type: INDEX; Schema: launcher; Owner: -
--

CREATE INDEX package_kind_visible ON launcher.package USING btree (kind, id) WHERE (live_count > 0);


--
-- Name: package_title_visible; Type: INDEX; Schema: launcher; Owner: -
--

CREATE INDEX package_title_visible ON launcher.package USING btree (kind, title_key, id) WHERE (live_count > 0);


--
-- Name: release_visible; Type: INDEX; Schema: launcher; Owner: -
--

CREATE INDEX release_visible ON launcher.release USING btree (package_id, published_at DESC, id DESC) WHERE (withdrawn_at IS NULL);


--
-- Name: release release_package_id_fkey; Type: FK CONSTRAINT; Schema: launcher; Owner: -
--

ALTER TABLE ONLY launcher.release
    ADD CONSTRAINT release_package_id_fkey FOREIGN KEY (package_id) REFERENCES launcher.package(id);


--
-- PostgreSQL database dump complete
--


