-- Private personal Context selection pointers: Access-owned convenience state.
-- Shared Contexts, their revisions, public Realm/entry selections, Statements
-- and decisions are graph-owned. A row here never grants authority, never
-- appears in the graph and pins exact graph revisions by IRI only.
CREATE TABLE access.context_selection (
    id uuid PRIMARY KEY,
    principal_id uuid NOT NULL REFERENCES access.principal(id),
    scope_profile text NOT NULL CHECK (scope_profile = 'context-selection-scope-v1'),
    scope_kind text NOT NULL
        CHECK (scope_kind IN ('default', 'domain', 'object', 'object-relation')),
    scope_object text CHECK (scope_object ~ '^https://rezics[.]com/id/[0-9a-f-]{36}$'),
    scope_relation text CHECK (length(scope_relation) <= 2048
        AND scope_relation ~ '^https?://[^[:space:]<>"{}|\\^`]+$'),
    scope_domain text CHECK (scope_domain ~ '^https://rezics[.]com/id/[0-9a-f-]{36}$'),
    -- One canonical key per scope keeps the bounded resolver lookup a single
    -- index probe with at most CONTEXT_LIMITS.scopeCandidates keys.
    scope_key text NOT NULL GENERATED ALWAYS AS (scope_kind || '|'
        || coalesce(scope_object, '') || '|' || coalesce(scope_relation, '') || '|'
        || coalesce(scope_domain, '')) STORED,
    head_revision uuid NOT NULL,
    CONSTRAINT context_selection_scope_shape CHECK (
        (scope_kind = 'default' AND scope_object IS NULL AND scope_relation IS NULL
            AND scope_domain IS NULL)
        OR (scope_kind = 'domain' AND scope_object IS NULL AND scope_relation IS NULL
            AND scope_domain IS NOT NULL)
        OR (scope_kind = 'object' AND scope_object IS NOT NULL AND scope_relation IS NULL
            AND scope_domain IS NULL)
        OR (scope_kind = 'object-relation' AND scope_object IS NOT NULL
            AND scope_relation IS NOT NULL AND scope_domain IS NULL)),
    CONSTRAINT context_selection_scope_once UNIQUE (principal_id, scope_profile, scope_key),
    CONSTRAINT context_selection_principal UNIQUE (id, principal_id)
);

-- Immutable selection history. A cleared revision is explicit state: it
-- retains the head for compare-and-swap and resolves to the next precedence
-- level, never to an inferred Global selection.
CREATE TABLE access.context_selection_revision (
    id uuid PRIMARY KEY,
    selection_id uuid NOT NULL REFERENCES access.context_selection(id),
    generation bigint NOT NULL CHECK (generation >= 1),
    predecessor_generation bigint,
    state text NOT NULL CHECK (state IN ('selected', 'cleared')),
    context text CHECK (context ~
        '^(https://rezics[.]com/id/[0-9a-f-]{36}|urn:rezics:semantic-context:global)$'),
    semantic_revision text CHECK (semantic_revision ~ '^https://rezics[.]com/id/[0-9a-f-]{36}$'),
    preference_revision text
        CHECK (preference_revision ~ '^https://rezics[.]com/id/[0-9a-f-]{36}$'),
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT context_selection_revision_order UNIQUE (selection_id, generation),
    CONSTRAINT context_selection_revision_owner UNIQUE (selection_id, id),
    CONSTRAINT context_selection_revision_chain CHECK (
        (generation = 1 AND predecessor_generation IS NULL)
        OR (generation > 1 AND predecessor_generation = generation - 1)),
    CONSTRAINT context_selection_revision_predecessor FOREIGN KEY (selection_id, predecessor_generation)
        REFERENCES access.context_selection_revision (selection_id, generation),
    CONSTRAINT context_selection_revision_state CHECK (
        (state = 'selected' AND context IS NOT NULL AND semantic_revision IS NOT NULL)
        OR (state = 'cleared' AND context IS NULL AND semantic_revision IS NULL
            AND preference_revision IS NULL))
);

ALTER TABLE access.context_selection ADD CONSTRAINT context_selection_head
    FOREIGN KEY (id, head_revision)
    REFERENCES access.context_selection_revision (selection_id, id)
    DEFERRABLE INITIALLY DEFERRED;

-- One receipt per committed selection change; a replayed key returns it.
CREATE TABLE access.context_selection_receipt (
    principal_id uuid NOT NULL REFERENCES access.principal(id),
    idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
    request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
    selection_id uuid NOT NULL,
    revision_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (principal_id, idempotency_key),
    CONSTRAINT context_selection_receipt_once UNIQUE (revision_id),
    CONSTRAINT context_selection_receipt_owner FOREIGN KEY (selection_id, principal_id)
        REFERENCES access.context_selection (id, principal_id),
    CONSTRAINT context_selection_receipt_revision FOREIGN KEY (selection_id, revision_id)
        REFERENCES access.context_selection_revision (selection_id, id)
);

-- Scope identity is fixed; the head only advances to its own next revision.
-- A change inserts revision n+1 first, then moves the head in the same transaction.
CREATE FUNCTION access.keep_context_selection_head() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    old_generation bigint;
    new_generation bigint;
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Context selection heads are retained' USING ERRCODE = '23514';
    END IF;
    -- Generated scope_key is not yet computed in NEW; compare its inputs.
    IF NEW.id <> OLD.id OR NEW.principal_id <> OLD.principal_id
        OR NEW.scope_profile <> OLD.scope_profile OR NEW.scope_kind <> OLD.scope_kind
        OR NEW.scope_object IS DISTINCT FROM OLD.scope_object
        OR NEW.scope_relation IS DISTINCT FROM OLD.scope_relation
        OR NEW.scope_domain IS DISTINCT FROM OLD.scope_domain THEN
        RAISE EXCEPTION 'immutable Context selection scope' USING ERRCODE = '23514';
    END IF;
    IF NEW.head_revision = OLD.head_revision THEN
        RETURN NEW;
    END IF;
    SELECT generation INTO old_generation FROM access.context_selection_revision
        WHERE id = OLD.head_revision AND selection_id = OLD.id;
    SELECT generation INTO new_generation FROM access.context_selection_revision
        WHERE id = NEW.head_revision AND selection_id = NEW.id;
    IF old_generation IS NULL OR new_generation IS NULL
        OR new_generation <> old_generation + 1 THEN
        RAISE EXCEPTION 'Context selection head must advance by one revision'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER context_selection_head_order BEFORE UPDATE OR DELETE
    ON access.context_selection FOR EACH ROW
    EXECUTE FUNCTION access.keep_context_selection_head();

-- Every committed revision is the head at commit, so history has no orphan
-- future revision that could block the next compare-and-swap.
CREATE FUNCTION access.require_context_selection_revision_head() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM access.context_selection
        WHERE id = NEW.selection_id AND head_revision = NEW.id) THEN
        RAISE EXCEPTION 'Context selection revision must become the head'
            USING ERRCODE = '23514';
    END IF;
    RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER context_selection_revision_is_head AFTER INSERT
    ON access.context_selection_revision DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
    EXECUTE FUNCTION access.require_context_selection_revision_head();

CREATE FUNCTION access.reject_context_selection_record_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'immutable Access Context selection revision/receipt' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER context_selection_revision_immutable BEFORE UPDATE OR DELETE
    ON access.context_selection_revision FOR EACH ROW
    EXECUTE FUNCTION access.reject_context_selection_record_mutation();
CREATE TRIGGER context_selection_receipt_immutable BEFORE UPDATE OR DELETE
    ON access.context_selection_receipt FOR EACH ROW
    EXECUTE FUNCTION access.reject_context_selection_record_mutation();
