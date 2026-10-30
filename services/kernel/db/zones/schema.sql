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
-- Name: zones; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA zones;


--
-- Name: record_purge_generation(); Type: FUNCTION; Schema: zones; Owner: -
--

CREATE FUNCTION zones.record_purge_generation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF NEW.state='deleted' AND OLD.state='active' THEN
  NEW.deletion_generation:=gen_random_uuid();NEW.deletion_transaction_id:=NEW.transaction_id;
 END IF;
 RETURN NEW;
END; $$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: zone; Type: TABLE; Schema: zones; Owner: -
--

CREATE TABLE zones.zone (
    route integer NOT NULL,
    zone_id uuid NOT NULL,
    revision bigint NOT NULL,
    state text NOT NULL,
    owner_id uuid,
    visibility text NOT NULL,
    configuration jsonb,
    mounts uuid[] DEFAULT '{}'::uuid[],
    release_digest text NOT NULL,
    public_ever boolean DEFAULT false NOT NULL,
    write_fenced boolean DEFAULT false NOT NULL,
    lifecycle_revision bigint DEFAULT 1 NOT NULL,
    withholding jsonb DEFAULT '{}'::jsonb NOT NULL,
    held boolean DEFAULT false NOT NULL,
    deleted_at timestamp with time zone,
    restore_until timestamp with time zone,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    creation_transaction_id uuid NOT NULL,
    transaction_id uuid NOT NULL,
    erasure_key bigint DEFAULT nextval('semantic.erasure_record_key'::regclass) NOT NULL,
    deletion_generation uuid,
    deletion_transaction_id uuid,
    CONSTRAINT zone_check CHECK ((route = ((get_byte(uuid_send(zone_id), 10) * 256) + get_byte(uuid_send(zone_id), 11)))),
    CONSTRAINT zone_check1 CHECK (((owner_id IS NULL) OR (route = ((get_byte(uuid_send(owner_id), 10) * 256) + get_byte(uuid_send(owner_id), 11))))),
    CONSTRAINT zone_check2 CHECK (((deleted_at IS NULL) = (restore_until IS NULL))),
    CONSTRAINT zone_lifecycle_revision_check CHECK ((lifecycle_revision > 0)),
    CONSTRAINT zone_mounts_check CHECK ((cardinality(mounts) <= 16)),
    CONSTRAINT zone_revision_check CHECK ((revision > 0)),
    CONSTRAINT zone_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT zone_state_check CHECK ((state = ANY (ARRAY['active'::text, 'deleted'::text, 'purge_pending'::text, 'purged'::text]))),
    CONSTRAINT zone_visibility_check CHECK ((visibility = ANY (ARRAY['private'::text, 'unlisted'::text, 'public'::text])))
);


--
-- Name: zone zone_pkey; Type: CONSTRAINT; Schema: zones; Owner: -
--

ALTER TABLE ONLY zones.zone
    ADD CONSTRAINT zone_pkey PRIMARY KEY (route, zone_id);


--
-- Name: zone_erasure_key; Type: INDEX; Schema: zones; Owner: -
--

CREATE UNIQUE INDEX zone_erasure_key ON zones.zone USING btree (erasure_key, route);


--
-- Name: zone_owner_keys; Type: INDEX; Schema: zones; Owner: -
--

CREATE INDEX zone_owner_keys ON zones.zone USING btree (route, owner_id, state, zone_id);


--
-- Name: zone_record_retention_due; Type: INDEX; Schema: zones; Owner: -
--

CREATE INDEX zone_record_retention_due ON zones.zone USING btree (route, zone_id) WHERE (state = 'deleted'::text);


--
-- Name: zone zone_erasure_capture; Type: TRIGGER; Schema: zones; Owner: -
--

CREATE CONSTRAINT TRIGGER zone_erasure_capture AFTER INSERT OR UPDATE ON zones.zone DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_zone_erasure();


--
-- Name: zone zone_record_purge_commit; Type: TRIGGER; Schema: zones; Owner: -
--

CREATE CONSTRAINT TRIGGER zone_record_purge_commit AFTER UPDATE ON zones.zone DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.resource_record_purge_commit();


--
-- Name: zone zone_record_purge_gate; Type: TRIGGER; Schema: zones; Owner: -
--

CREATE TRIGGER zone_record_purge_gate BEFORE DELETE OR UPDATE ON zones.zone FOR EACH ROW EXECUTE FUNCTION semantic.record_purge_source_gate();


--
-- Name: zone zone_record_purge_generation; Type: TRIGGER; Schema: zones; Owner: -
--

CREATE TRIGGER zone_record_purge_generation BEFORE UPDATE ON zones.zone FOR EACH ROW EXECUTE FUNCTION zones.record_purge_generation();


--
-- Name: zone zone_record_purge_writer; Type: TRIGGER; Schema: zones; Owner: -
--

CREATE CONSTRAINT TRIGGER zone_record_purge_writer AFTER INSERT OR UPDATE ON zones.zone DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.record_purge_resource_writer();


--
-- Name: zone zone_record_retention; Type: TRIGGER; Schema: zones; Owner: -
--

CREATE TRIGGER zone_record_retention AFTER INSERT OR UPDATE OF state, deleted_at ON zones.zone FOR EACH ROW EXECUTE FUNCTION semantic.capture_record_retention();


--
-- PostgreSQL database dump complete
--


