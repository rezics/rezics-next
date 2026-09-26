-- Realm replies and Realm review over exact Content revisions (SUB05, SUB06,
-- SUB08). A reply body is an ordinary Content variant; its revisions, draft
-- head, receipts and outbox are the existing Content ones. Per-Realm
-- acceptance/placement stays a graph publication decision that references
-- the exact revision, this review decision and the existing
-- publication_preparation pin; nothing here is a second publication head.

-- Register the reply and review receipt actions (migration-022 registry).
INSERT INTO content.receipt_action (action) VALUES ('reply.create'), ('review.decide')
    ON CONFLICT DO NOTHING;

-- Reply identity: one utterance/content identity, its author and exact
-- original target. Thread reorganization and placements in other Realms never
-- rewrite these references; the row is immutable.
CREATE TABLE content.reply (
    id text PRIMARY KEY CHECK (id ~ '^https://rezics\.com/id/[0-9a-f-]{36}$'),
    variant_id text NOT NULL UNIQUE REFERENCES content.variant(id),
    author text NOT NULL CHECK (length(author) BETWEEN 1 AND 300),
    root_target text NOT NULL CHECK (length(root_target) BETWEEN 1 AND 300),
    -- Exact root revision reference (graph revision anchor or Content revision).
    root_revision text NOT NULL CHECK (length(root_revision) BETWEEN 1 AND 300),
    parent_reply text,
    parent_variant text,
    parent_revision uuid,
    -- Exact semantic Context revision the author applied, when any.
    context_revision text CHECK (length(context_revision) BETWEEN 1 AND 300),
    operation_id text NOT NULL UNIQUE REFERENCES content.receipt(operation_id),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (id, variant_id),
    FOREIGN KEY (parent_reply, parent_variant) REFERENCES content.reply(id, variant_id),
    FOREIGN KEY (parent_variant, parent_revision) REFERENCES content.revision(variant_id, id),
    CHECK ((parent_reply IS NULL) = (parent_variant IS NULL)
        AND (parent_reply IS NULL) = (parent_revision IS NULL)),
    CHECK (parent_reply IS NULL OR parent_reply <> id)
);
CREATE INDEX reply_root_idx ON content.reply (root_target, created_at, id);
CREATE INDEX reply_parent_idx ON content.reply (parent_reply, created_at, id) WHERE parent_reply IS NOT NULL;
CREATE INDEX reply_parent_revision_fk ON content.reply (parent_variant, parent_revision)
    WHERE parent_variant IS NOT NULL;

CREATE FUNCTION content.guard_reply() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'immutable Content reply identity' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM content.variant v WHERE v.id = NEW.variant_id AND v.resource_id = NEW.id)
        OR NOT EXISTS (SELECT 1 FROM content.receipt r WHERE r.operation_id = NEW.operation_id
            AND r.action = 'reply.create' AND r.variant_id = NEW.variant_id) THEN
        RAISE EXCEPTION 'reply must own its variant and its reply.create receipt' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER reply_guard BEFORE INSERT OR UPDATE OR DELETE ON content.reply
    FOR EACH ROW EXECUTE FUNCTION content.guard_reply();

-- One Realm review chain per (Realm, exact revision). A decision binds the
-- revision digest, the Realm review policy revision, the human or AI method
-- revision and a digest of the exact dependencies it examined. Appeals,
-- reversals and revocations append a new attributable decision; the unique
-- (realm, revision, generation) key rejects a concurrent stale decision.
CREATE TABLE content.realm_review_decision (
    id uuid PRIMARY KEY,
    realm text NOT NULL CHECK (realm ~ '^https://rezics\.com/id/[0-9a-f-]{36}$'),
    variant_id text NOT NULL,
    revision_id uuid NOT NULL,
    review_generation bigint NOT NULL CHECK (review_generation >= 1),
    supersedes uuid UNIQUE,
    outcome text NOT NULL CHECK (outcome IN ('approved', 'rejected', 'unavailable', 'revoked')),
    policy text NOT NULL CHECK (length(policy) BETWEEN 1 AND 300),
    policy_revision text NOT NULL CHECK (length(policy_revision) BETWEEN 1 AND 300),
    method text NOT NULL CHECK (method IN ('human', 'ai')),
    method_revision text NOT NULL CHECK (length(method_revision) BETWEEN 1 AND 300),
    reviewer text NOT NULL CHECK (length(reviewer) BETWEEN 1 AND 300),
    revision_digest text NOT NULL CHECK (revision_digest ~ '^[0-9a-f]{64}$'),
    dependency_digest text NOT NULL CHECK (dependency_digest ~ '^[0-9a-f]{64}$'),
    reason_reference text CHECK (length(reason_reference) BETWEEN 1 AND 128),
    operation_id text NOT NULL UNIQUE REFERENCES content.receipt(operation_id),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (realm, revision_id, review_generation),
    UNIQUE (id, realm, revision_id),
    FOREIGN KEY (variant_id, revision_id) REFERENCES content.revision(variant_id, id),
    FOREIGN KEY (supersedes, realm, revision_id)
        REFERENCES content.realm_review_decision(id, realm, revision_id),
    CHECK ((review_generation = 1) = (supersedes IS NULL)),
    CHECK (outcome <> 'revoked' OR supersedes IS NOT NULL),
    CHECK (outcome NOT IN ('rejected', 'revoked') OR reason_reference IS NOT NULL)
);
CREATE INDEX realm_review_decision_revision_fk ON content.realm_review_decision (variant_id, revision_id);

-- Review and placement preparation both lock the reviewed variant row, so a
-- revocation and a preparation of the same revision serialize.
CREATE FUNCTION content.guard_realm_review_decision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    previous content.realm_review_decision;
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'immutable Realm review decision' USING ERRCODE = '23514';
    END IF;
    PERFORM 1 FROM content.variant WHERE id = NEW.variant_id FOR UPDATE;
    IF NOT EXISTS (SELECT 1 FROM content.revision r WHERE r.id = NEW.revision_id
            AND r.byte_digest = NEW.revision_digest)
        OR NOT EXISTS (SELECT 1 FROM content.receipt r WHERE r.operation_id = NEW.operation_id
            AND r.action = 'review.decide' AND r.revision_id = NEW.revision_id) THEN
        RAISE EXCEPTION 'review must bind the exact revision digest and its review.decide receipt'
            USING ERRCODE = '23514';
    END IF;
    IF NEW.supersedes IS NOT NULL THEN
        SELECT * INTO previous FROM content.realm_review_decision WHERE id = NEW.supersedes;
        IF previous.review_generation <> NEW.review_generation - 1
            OR (NEW.outcome = 'revoked' AND previous.outcome <> 'approved') THEN
            RAISE EXCEPTION 'review decision must extend its chain; only an approval can be revoked'
                USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER realm_review_decision_guard BEFORE INSERT OR UPDATE OR DELETE
    ON content.realm_review_decision FOR EACH ROW
    EXECUTE FUNCTION content.guard_realm_review_decision();

-- Binds one Realm placement's existing publication preparation (the exact
-- revision pin) to the approved review that admits it. Only the chain's
-- current decision, approved for that exact revision, qualifies: pending,
-- unavailable, rejected or revoked review cannot prepare a placement, and an
-- edited later revision needs its own approval.
CREATE TABLE content.realm_placement_preparation (
    operation_id text PRIMARY KEY REFERENCES content.publication_preparation(operation_id),
    realm text NOT NULL,
    variant_id text NOT NULL,
    revision_id uuid NOT NULL,
    review_decision_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (variant_id, revision_id) REFERENCES content.revision(variant_id, id),
    FOREIGN KEY (review_decision_id, realm, revision_id)
        REFERENCES content.realm_review_decision(id, realm, revision_id)
);
CREATE INDEX realm_placement_review_fk ON content.realm_placement_preparation
    (review_decision_id, realm, revision_id);
CREATE INDEX realm_placement_revision_fk ON content.realm_placement_preparation (variant_id, revision_id);

CREATE FUNCTION content.guard_realm_placement_preparation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'immutable Realm placement preparation' USING ERRCODE = '23514';
    END IF;
    PERFORM 1 FROM content.variant WHERE id = NEW.variant_id FOR UPDATE;
    IF NOT EXISTS (SELECT 1 FROM content.publication_preparation p
            WHERE p.operation_id = NEW.operation_id AND p.revision_id = NEW.revision_id
              AND p.status = 'pending')
        OR NOT EXISTS (SELECT 1 FROM content.realm_review_decision d
            WHERE d.id = NEW.review_decision_id AND d.outcome = 'approved'
              AND NOT EXISTS (SELECT 1 FROM content.realm_review_decision later
                  WHERE later.supersedes = d.id)) THEN
        RAISE EXCEPTION 'Realm placement needs a pending pin and the current approval of that exact revision'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER realm_placement_preparation_guard BEFORE INSERT OR UPDATE OR DELETE
    ON content.realm_placement_preparation FOR EACH ROW
    EXECUTE FUNCTION content.guard_realm_placement_preparation();
