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

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: account; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.account (
    id text NOT NULL,
    "accountId" text NOT NULL,
    "providerId" text NOT NULL,
    "userId" text NOT NULL,
    "accessToken" text,
    "refreshToken" text,
    "idToken" text,
    "accessTokenExpiresAt" timestamp with time zone,
    "refreshTokenExpiresAt" timestamp with time zone,
    scope text,
    password text,
    "createdAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL,
    CONSTRAINT password_owner CHECK ((("providerId" = 'credential'::text) AND ("accountId" = "userId")))
);


--
-- Name: auth_attempt_counter; Type: TABLE; Schema: public; Owner: -
--

CREATE UNLOGGED TABLE public.auth_attempt_counter (
    key text NOT NULL,
    count integer NOT NULL,
    last_request timestamp with time zone NOT NULL,
    accepted boolean NOT NULL,
    CONSTRAINT auth_attempt_counter_count_check CHECK ((count > 0)),
    CONSTRAINT auth_attempt_counter_key_check CHECK ((key ~ '^[0-9a-f]{64}$'::text))
);


--
-- Name: auth_client; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_client (
    client_id text NOT NULL,
    first_party boolean NOT NULL,
    scopes text[] NOT NULL
);


--
-- Name: auth_client_coverage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_client_coverage (
    client_id text NOT NULL,
    after_account text DEFAULT ''::text NOT NULL,
    ready boolean DEFAULT false NOT NULL,
    ready_after timestamp with time zone DEFAULT (CURRENT_TIMESTAMP + '00:05:00'::interval) NOT NULL
);


--
-- Name: auth_client_reduction; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_client_reduction (
    client_id text NOT NULL,
    operation_id text NOT NULL,
    scopes text[] NOT NULL,
    first_party boolean NOT NULL
);


--
-- Name: auth_client_reduction_progress; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_client_reduction_progress (
    operation_id text NOT NULL,
    client_id text NOT NULL,
    scopes text[] NOT NULL,
    first_party boolean NOT NULL,
    after_account text DEFAULT ''::text NOT NULL,
    page_after text DEFAULT ''::text NOT NULL,
    terminal_account text,
    completed boolean DEFAULT false NOT NULL
);


--
-- Name: auth_consent; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_consent (
    account_id text NOT NULL,
    client_id text NOT NULL,
    scopes text[] NOT NULL
);


--
-- Name: auth_effect_receipt; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_effect_receipt (
    receipt_id text NOT NULL,
    account_id text NOT NULL,
    purpose text NOT NULL,
    minimum_authn_epoch integer NOT NULL,
    CONSTRAINT auth_effect_receipt_minimum_authn_epoch_check CHECK ((minimum_authn_epoch >= 0))
);


--
-- Name: auth_key_assertion; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_key_assertion (
    account_id text NOT NULL,
    jti text NOT NULL,
    expires_at timestamp with time zone NOT NULL
);


--
-- Name: auth_provisioning_receipt; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_provisioning_receipt (
    idempotency_key text NOT NULL,
    account_id text NOT NULL,
    digest bytea NOT NULL
);


--
-- Name: auth_public_key; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_public_key (
    account_id text NOT NULL,
    kid text NOT NULL,
    public_jwk jsonb NOT NULL,
    CONSTRAINT auth_public_key_public_jwk_check CHECK ((((public_jwk ->> 'alg'::text) = 'ES256'::text) AND (NOT (public_jwk ? 'd'::text)) AND (NOT (public_jwk ? 'k'::text))))
);


--
-- Name: auth_recovery; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_recovery (
    proof_hash text NOT NULL,
    account_id text NOT NULL,
    authn_epoch integer NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    CONSTRAINT auth_recovery_authn_epoch_check CHECK ((authn_epoch >= 0))
);


--
-- Name: auth_registration_stage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_registration_stage (
    registration_id text NOT NULL,
    request_key text NOT NULL,
    handle text NOT NULL,
    account_id text NOT NULL,
    reservation_id text,
    request_digest bytea NOT NULL,
    ciphertext bytea,
    credential_digest bytea,
    expires_at timestamp with time zone,
    completed_at timestamp with time zone,
    expired_at timestamp with time zone
);


--
-- Name: auth_session_opening; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_session_opening (
    session_id text NOT NULL,
    subject_account_id text NOT NULL,
    acting_human_id text NOT NULL,
    operator_account_id text NOT NULL,
    receipt_id text NOT NULL,
    opened_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: auth_signing_generation; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_signing_generation (
    singleton boolean DEFAULT true NOT NULL,
    generation integer DEFAULT 0 NOT NULL,
    current_kid text,
    next_kid text,
    retiring_kid text,
    upgrade_after timestamp with time zone NOT NULL,
    CONSTRAINT auth_signing_generation_generation_check CHECK ((generation >= 0)),
    CONSTRAINT auth_signing_generation_singleton_check CHECK (singleton)
);


--
-- Name: auth_signing_key; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_signing_key (
    kid text CONSTRAINT auth_signing_key_kid_not_null1 NOT NULL,
    slot text NOT NULL,
    private_jwk jsonb CONSTRAINT auth_signing_key_private_jwk_not_null1 NOT NULL,
    retain_until timestamp with time zone,
    CONSTRAINT auth_signing_key_check CHECK (((slot = 'retiring'::text) = (retain_until IS NOT NULL))),
    CONSTRAINT auth_signing_key_private_jwk_check1 CHECK (((private_jwk ->> 'd'::text) IS NOT NULL)),
    CONSTRAINT auth_signing_key_slot_check CHECK ((slot = ANY (ARRAY['current'::text, 'next'::text, 'retiring'::text])))
);


--
-- Name: auth_signing_key_archive; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_signing_key_archive (
    kid text CONSTRAINT auth_signing_key_kid_not_null NOT NULL,
    private_jwk jsonb CONSTRAINT auth_signing_key_private_jwk_not_null NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP CONSTRAINT auth_signing_key_created_at_not_null NOT NULL,
    CONSTRAINT auth_signing_key_private_jwk_check CHECK (((private_jwk ->> 'd'::text) IS NOT NULL))
);


--
-- Name: auth_workflow_request; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_workflow_request (
    workflow_id text NOT NULL,
    digest bytea NOT NULL,
    request jsonb NOT NULL
);


--
-- Name: schema_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schema_migrations (
    version character varying NOT NULL
);


--
-- Name: session; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.session (
    id text NOT NULL,
    "expiresAt" timestamp with time zone NOT NULL,
    token text NOT NULL,
    "createdAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL,
    "ipAddress" text,
    "userAgent" text,
    "userId" text NOT NULL,
    "clientId" text NOT NULL,
    "grantedScope" text NOT NULL,
    "authnEpoch" integer NOT NULL,
    "authTime" integer NOT NULL,
    "authMethods" text NOT NULL,
    CONSTRAINT session_authentication CHECK ((("authnEpoch" >= 0) AND ("authTime" >= 0) AND ("authMethods" = ANY (ARRAY['pwd'::text, 'private_key_jwt'::text, 'operator'::text]))))
);


--
-- Name: user; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."user" (
    id text NOT NULL,
    name text NOT NULL,
    email text,
    "emailVerified" boolean NOT NULL,
    image text,
    "createdAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT inert_profile CHECK (((name = ''::text) AND (image IS NULL)))
);


--
-- Name: verification; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.verification (
    id text NOT NULL,
    identifier text NOT NULL,
    value text NOT NULL,
    "expiresAt" timestamp with time zone NOT NULL,
    "createdAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: account account_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account
    ADD CONSTRAINT account_pkey PRIMARY KEY (id);


--
-- Name: auth_attempt_counter auth_attempt_counter_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_attempt_counter
    ADD CONSTRAINT auth_attempt_counter_pkey PRIMARY KEY (key);


--
-- Name: auth_client_coverage auth_client_coverage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_client_coverage
    ADD CONSTRAINT auth_client_coverage_pkey PRIMARY KEY (client_id);


--
-- Name: auth_client auth_client_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_client
    ADD CONSTRAINT auth_client_pkey PRIMARY KEY (client_id);


--
-- Name: auth_client_reduction auth_client_reduction_operation_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_client_reduction
    ADD CONSTRAINT auth_client_reduction_operation_id_key UNIQUE (operation_id);


--
-- Name: auth_client_reduction auth_client_reduction_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_client_reduction
    ADD CONSTRAINT auth_client_reduction_pkey PRIMARY KEY (client_id);


--
-- Name: auth_client_reduction_progress auth_client_reduction_progress_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_client_reduction_progress
    ADD CONSTRAINT auth_client_reduction_progress_pkey PRIMARY KEY (operation_id);


--
-- Name: auth_consent auth_consent_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_consent
    ADD CONSTRAINT auth_consent_pkey PRIMARY KEY (account_id, client_id);


--
-- Name: auth_effect_receipt auth_effect_receipt_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_effect_receipt
    ADD CONSTRAINT auth_effect_receipt_pkey PRIMARY KEY (receipt_id);


--
-- Name: auth_key_assertion auth_key_assertion_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_key_assertion
    ADD CONSTRAINT auth_key_assertion_pkey PRIMARY KEY (account_id, jti);


--
-- Name: auth_provisioning_receipt auth_provisioning_receipt_account_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_provisioning_receipt
    ADD CONSTRAINT auth_provisioning_receipt_account_id_key UNIQUE (account_id);


--
-- Name: auth_provisioning_receipt auth_provisioning_receipt_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_provisioning_receipt
    ADD CONSTRAINT auth_provisioning_receipt_pkey PRIMARY KEY (idempotency_key);


--
-- Name: auth_public_key auth_public_key_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_public_key
    ADD CONSTRAINT auth_public_key_pkey PRIMARY KEY (account_id, kid);


--
-- Name: auth_recovery auth_recovery_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_recovery
    ADD CONSTRAINT auth_recovery_pkey PRIMARY KEY (proof_hash);


--
-- Name: auth_registration_stage auth_registration_stage_account_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_registration_stage
    ADD CONSTRAINT auth_registration_stage_account_id_key UNIQUE (account_id);


--
-- Name: auth_registration_stage auth_registration_stage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_registration_stage
    ADD CONSTRAINT auth_registration_stage_pkey PRIMARY KEY (registration_id);


--
-- Name: auth_registration_stage auth_registration_stage_request_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_registration_stage
    ADD CONSTRAINT auth_registration_stage_request_key_key UNIQUE (request_key);


--
-- Name: auth_session_opening auth_session_opening_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_session_opening
    ADD CONSTRAINT auth_session_opening_pkey PRIMARY KEY (session_id);


--
-- Name: auth_session_opening auth_session_opening_receipt_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_session_opening
    ADD CONSTRAINT auth_session_opening_receipt_id_key UNIQUE (receipt_id);


--
-- Name: auth_signing_generation auth_signing_generation_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_signing_generation
    ADD CONSTRAINT auth_signing_generation_pkey PRIMARY KEY (singleton);


--
-- Name: auth_signing_key_archive auth_signing_key_archive_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_signing_key_archive
    ADD CONSTRAINT auth_signing_key_archive_pkey PRIMARY KEY (kid);


--
-- Name: auth_signing_key auth_signing_key_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_signing_key
    ADD CONSTRAINT auth_signing_key_pkey PRIMARY KEY (kid);


--
-- Name: auth_signing_key auth_signing_key_slot_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_signing_key
    ADD CONSTRAINT auth_signing_key_slot_key UNIQUE (slot);


--
-- Name: auth_workflow_request auth_workflow_request_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_workflow_request
    ADD CONSTRAINT auth_workflow_request_pkey PRIMARY KEY (workflow_id);


--
-- Name: account credential_owner_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account
    ADD CONSTRAINT credential_owner_unique UNIQUE ("userId", "providerId");


--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (version);


--
-- Name: session session_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session
    ADD CONSTRAINT session_pkey PRIMARY KEY (id);


--
-- Name: session session_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session
    ADD CONSTRAINT session_token_key UNIQUE (token);


--
-- Name: user user_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."user"
    ADD CONSTRAINT user_email_key UNIQUE (email);


--
-- Name: user user_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."user"
    ADD CONSTRAINT user_pkey PRIMARY KEY (id);


--
-- Name: verification verification_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.verification
    ADD CONSTRAINT verification_pkey PRIMARY KEY (id);


--
-- Name: account_userId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "account_userId_idx" ON public.account USING btree ("userId");


--
-- Name: auth_attempt_counter_retention; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_attempt_counter_retention ON public.auth_attempt_counter USING btree (last_request, key);


--
-- Name: auth_consent_client_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX auth_consent_client_owner ON public.auth_consent USING btree (client_id, account_id);


--
-- Name: auth_recovery_account_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_recovery_account_id_idx ON public.auth_recovery USING btree (account_id);


--
-- Name: auth_registration_stage_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_registration_stage_due ON public.auth_registration_stage USING btree (expires_at, registration_id) WHERE ((completed_at IS NULL) AND (expired_at IS NULL));


--
-- Name: auth_session_opening_subject_account_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_session_opening_subject_account_id_idx ON public.auth_session_opening USING btree (subject_account_id);


--
-- Name: session_userId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "session_userId_idx" ON public.session USING btree ("userId");


--
-- Name: verification_expiry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX verification_expiry_idx ON public.verification USING btree ("expiresAt", id);


--
-- Name: verification_identifier_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX verification_identifier_idx ON public.verification USING btree (identifier);


--
-- Name: verification_latest_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX verification_latest_idx ON public.verification USING btree (identifier, "createdAt" DESC, id DESC);


--
-- Name: account account_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account
    ADD CONSTRAINT "account_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."user"(id) ON DELETE CASCADE;


--
-- Name: auth_client_coverage auth_client_coverage_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_client_coverage
    ADD CONSTRAINT auth_client_coverage_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.auth_client(client_id);


--
-- Name: auth_client_reduction auth_client_reduction_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_client_reduction
    ADD CONSTRAINT auth_client_reduction_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.auth_client(client_id);


--
-- Name: auth_client_reduction_progress auth_client_reduction_progress_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_client_reduction_progress
    ADD CONSTRAINT auth_client_reduction_progress_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.auth_client(client_id);


--
-- Name: auth_consent auth_consent_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_consent
    ADD CONSTRAINT auth_consent_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.auth_client(client_id) ON DELETE CASCADE;


--
-- Name: auth_key_assertion auth_key_assertion_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_key_assertion
    ADD CONSTRAINT auth_key_assertion_account_id_fkey FOREIGN KEY (account_id) REFERENCES public."user"(id) ON DELETE CASCADE;


--
-- Name: auth_public_key auth_public_key_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_public_key
    ADD CONSTRAINT auth_public_key_account_id_fkey FOREIGN KEY (account_id) REFERENCES public."user"(id) ON DELETE CASCADE;


--
-- Name: auth_recovery auth_recovery_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_recovery
    ADD CONSTRAINT auth_recovery_account_id_fkey FOREIGN KEY (account_id) REFERENCES public."user"(id) ON DELETE CASCADE;


--
-- Name: auth_session_opening auth_session_opening_subject_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_session_opening
    ADD CONSTRAINT auth_session_opening_subject_account_id_fkey FOREIGN KEY (subject_account_id) REFERENCES public."user"(id) ON DELETE CASCADE;


--
-- Name: session session_client_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session
    ADD CONSTRAINT session_client_fk FOREIGN KEY ("clientId") REFERENCES public.auth_client(client_id);


--
-- Name: session session_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session
    ADD CONSTRAINT "session_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."user"(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--

