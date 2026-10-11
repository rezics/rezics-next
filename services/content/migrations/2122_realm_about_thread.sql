-- An owner index for the canonical page discussion, independent of Zone routes
-- and resource revisions. Reservations commit before any draft/graph effects.
CREATE TABLE content.realm_about_thread (
    realm text NOT NULL CHECK (realm ~ '^https://rezics\.com/id/[0-9a-f-]{36}$'),
    about text NOT NULL CHECK (about ~ '^https://rezics\.com/id/[0-9a-f-]{36}$'),
    opener_reply text NOT NULL UNIQUE,
    root_revision text NOT NULL CHECK (length(root_revision) BETWEEN 1 AND 300),
    revision_id uuid,
    state text NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved', 'active')),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (realm, about),
    UNIQUE (realm, about, opener_reply),
    CHECK ((state = 'active') = (revision_id IS NOT NULL))
);

CREATE TABLE content.realm_about_post_operation (
    id uuid PRIMARY KEY,
    actor text NOT NULL CHECK (actor ~ '^https://rezics\.com/id/[0-9a-f-]{36}$'),
    intent_key text NOT NULL CHECK (length(intent_key) BETWEEN 1 AND 128),
    intent_digest text NOT NULL CHECK (intent_digest ~ '^[0-9a-f]{64}$'),
    requested_root_revision text NOT NULL CHECK (length(requested_root_revision) BETWEEN 1 AND 300),
    realm text NOT NULL,
    about text NOT NULL,
    reply text NOT NULL UNIQUE CHECK (reply ~ '^https://rezics\.com/id/[0-9a-f-]{36}$'),
    variant_id text NOT NULL UNIQUE CHECK (variant_id ~ '^urn:rezics:variant:[0-9a-f-]{36}$'),
    opener_reply text NOT NULL,
    root_revision text NOT NULL CHECK (length(root_revision) BETWEEN 1 AND 300),
    parent_reply text,
    parent_revision uuid,
    phase text NOT NULL DEFAULT 'selected' CHECK (phase IN ('selected', 'drafted', 'identified', 'posted')),
    revision_id uuid,
    draft_operation_id text UNIQUE REFERENCES content.receipt(operation_id),
    identity_operation_id text UNIQUE REFERENCES content.receipt(operation_id),
    placement_operation_id text UNIQUE REFERENCES content.realm_placement_preparation(operation_id),
    -- Exact immutable graph receipt; its authority/settlement remains graph-owned.
    placement_receipt text CHECK (length(placement_receipt) BETWEEN 1 AND 300),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (actor, intent_key),
    FOREIGN KEY (realm, about, opener_reply)
        REFERENCES content.realm_about_thread(realm, about, opener_reply),
    CHECK ((reply = opener_reply) = (parent_reply IS NULL)),
    CHECK (parent_reply IS NULL OR parent_reply = opener_reply),
    CHECK (parent_reply IS NOT NULL OR parent_revision IS NULL),
    CHECK ((phase <> 'selected') = (revision_id IS NOT NULL AND draft_operation_id IS NOT NULL)),
    CHECK ((revision_id IS NULL) = (draft_operation_id IS NULL)),
    CHECK ((phase IN ('identified', 'posted')) = (identity_operation_id IS NOT NULL)),
    CHECK ((phase = 'posted') = (placement_operation_id IS NOT NULL AND placement_receipt IS NOT NULL)),
    CHECK ((placement_operation_id IS NULL) = (placement_receipt IS NULL)),
    CHECK (phase = 'selected' OR parent_reply IS NULL OR parent_revision IS NOT NULL)
);
ALTER TABLE content.realm_about_thread ADD CONSTRAINT realm_about_opener_operation_fk
    FOREIGN KEY (opener_reply) REFERENCES content.realm_about_post_operation(reply)
    DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION content.guard_realm_about_thread() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'canonical discussion keys are retained' USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'UPDATE' AND (
        (NEW.realm, NEW.about, NEW.opener_reply, NEW.root_revision, NEW.created_at)
            IS DISTINCT FROM (OLD.realm, OLD.about, OLD.opener_reply, OLD.root_revision, OLD.created_at)
        OR OLD.state = 'active' AND NEW IS DISTINCT FROM OLD
    ) THEN RAISE EXCEPTION 'canonical discussion selection is immutable' USING ERRCODE = '23514'; END IF;
    IF NEW.state = 'active' AND NOT EXISTS (
        SELECT 1 FROM content.realm_about_post_operation o
        WHERE o.reply = NEW.opener_reply AND o.phase = 'posted' AND o.revision_id = NEW.revision_id
    ) THEN RAISE EXCEPTION 'canonical opener must be posted' USING ERRCODE = '23514'; END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER realm_about_thread_guard BEFORE INSERT OR UPDATE OR DELETE ON content.realm_about_thread
    FOR EACH ROW EXECUTE FUNCTION content.guard_realm_about_thread();

CREATE FUNCTION content.guard_realm_about_post_operation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE canonical content.realm_about_thread;
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'discussion intent progress is retained' USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'UPDATE' AND (
        (NEW.id, NEW.actor, NEW.intent_key, NEW.intent_digest, NEW.requested_root_revision, NEW.realm, NEW.about,
         NEW.reply, NEW.variant_id, NEW.opener_reply, NEW.root_revision, NEW.parent_reply, NEW.created_at)
        IS DISTINCT FROM
        (OLD.id, OLD.actor, OLD.intent_key, OLD.intent_digest, OLD.requested_root_revision, OLD.realm, OLD.about,
         OLD.reply, OLD.variant_id, OLD.opener_reply, OLD.root_revision, OLD.parent_reply, OLD.created_at)
        OR array_position(ARRAY['selected','drafted','identified','posted'], NEW.phase)
            < array_position(ARRAY['selected','drafted','identified','posted'], OLD.phase)
        OR OLD.parent_revision IS NOT NULL AND NEW.parent_revision IS DISTINCT FROM OLD.parent_revision
        OR OLD.revision_id IS NOT NULL AND NEW.revision_id IS DISTINCT FROM OLD.revision_id
        OR OLD.draft_operation_id IS NOT NULL AND NEW.draft_operation_id IS DISTINCT FROM OLD.draft_operation_id
        OR OLD.identity_operation_id IS NOT NULL AND NEW.identity_operation_id IS DISTINCT FROM OLD.identity_operation_id
        OR OLD.placement_operation_id IS NOT NULL AND NEW.placement_operation_id IS DISTINCT FROM OLD.placement_operation_id
        OR OLD.placement_receipt IS NOT NULL AND NEW.placement_receipt IS DISTINCT FROM OLD.placement_receipt
    ) THEN RAISE EXCEPTION 'discussion intent selection and effects are immutable' USING ERRCODE = '23514'; END IF;
    SELECT * INTO canonical FROM content.realm_about_thread
        WHERE realm = NEW.realm AND about = NEW.about;
    IF NOT FOUND OR NEW.root_revision <> canonical.root_revision
        OR NEW.opener_reply <> canonical.opener_reply
        OR NEW.parent_revision IS NOT NULL AND (
            canonical.state <> 'active' OR NEW.parent_revision IS DISTINCT FROM canonical.revision_id
        ) THEN RAISE EXCEPTION 'discussion selection differs from canonical key' USING ERRCODE = '23514'; END IF;
    IF NEW.phase <> 'selected' AND NOT EXISTS (
        SELECT 1 FROM content.receipt r JOIN content.revision v
            ON v.id = r.revision_id AND v.variant_id = r.variant_id
        JOIN content.reply_author a ON a.reply = NEW.reply AND a.variant_id = v.variant_id
        WHERE r.operation_id = NEW.draft_operation_id AND r.action = 'draft.save' AND r.outcome = 'succeeded'
          AND r.variant_id = NEW.variant_id AND r.revision_id = NEW.revision_id
          AND a.operation_id = r.operation_id
          AND a.author = NEW.actor AND a.root_target = NEW.about
          AND a.root_revision = NEW.root_revision AND a.origin_realm = NEW.realm
    ) THEN RAISE EXCEPTION 'discussion draft progress lacks its owner receipt' USING ERRCODE = '23514'; END IF;
    IF NEW.phase IN ('identified','posted') AND NOT EXISTS (
        SELECT 1 FROM content.reply p JOIN content.receipt r ON r.operation_id = p.operation_id
        WHERE p.id = NEW.reply AND p.operation_id = NEW.identity_operation_id
          AND r.revision_id = NEW.revision_id AND r.outcome = 'succeeded'
    ) THEN RAISE EXCEPTION 'discussion identity progress lacks its owner receipt' USING ERRCODE = '23514'; END IF;
    IF NEW.phase = 'posted' AND NOT EXISTS (
        SELECT 1 FROM content.realm_placement_preparation p
        WHERE p.operation_id = NEW.placement_operation_id AND p.realm = NEW.realm
          AND p.variant_id = NEW.variant_id AND p.revision_id = NEW.revision_id
    ) THEN RAISE EXCEPTION 'discussion placement differs from preparation' USING ERRCODE = '23514'; END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER realm_about_post_operation_guard BEFORE INSERT OR UPDATE OR DELETE ON content.realm_about_post_operation
    FOR EACH ROW EXECUTE FUNCTION content.guard_realm_about_post_operation();

-- Existing unrelated Realm posts are unconstrained. Only allocated discussion
-- identities must match the durable selection, including on direct SQL writes.
CREATE FUNCTION content.guard_reply_about_selection() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE intent content.realm_about_post_operation;
BEGIN
    SELECT * INTO intent FROM content.realm_about_post_operation WHERE reply = NEW.id FOR UPDATE;
    IF FOUND AND (intent.phase <> 'drafted' OR NEW.context_revision IS NOT NULL
        OR (NEW.variant_id, NEW.author, NEW.root_target, NEW.root_revision, NEW.origin_realm,
            NEW.parent_reply, NEW.parent_revision)
        IS DISTINCT FROM (intent.variant_id, intent.actor, intent.about, intent.root_revision,
            intent.realm, intent.parent_reply, intent.parent_revision)
        OR NOT EXISTS (SELECT 1 FROM content.receipt r WHERE r.operation_id = NEW.operation_id
            AND r.revision_id = intent.revision_id AND r.outcome = 'succeeded')
    ) THEN RAISE EXCEPTION 'reply differs from reserved discussion selection' USING ERRCODE = '23514'; END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER reply_about_selection_guard BEFORE INSERT ON content.reply
    FOR EACH ROW EXECUTE FUNCTION content.guard_reply_about_selection();
