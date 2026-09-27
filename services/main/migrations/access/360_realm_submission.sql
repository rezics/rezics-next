-- A submission routes an already public, exact contribution to one Realm.
-- A correction replaces an exact Realm selection, never a Global draft/title.
CREATE TABLE access.realm_submission (
    id uuid PRIMARY KEY,
    realm text NOT NULL,
    kind text NOT NULL CHECK (kind IN ('contribution', 'correction')),
    work text NOT NULL,
    main_version text NOT NULL,
    contribution text NOT NULL,
    publication_decision text NOT NULL,
    selected_draft text NOT NULL,
    correction_of text,
    submitting_agent text NOT NULL REFERENCES access.authority_subject(id),
    state text NOT NULL CHECK (state IN
        ('pending', 'deciding', 'accepted', 'rejected', 'changes-requested', 'withdrawn', 'stale')),
    revision uuid NOT NULL UNIQUE,
    generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
    decision_operation uuid REFERENCES access.admission(id),
    reviewer text REFERENCES access.authority_subject(id),
    public_reason text CHECK (length(public_reason) BETWEEN 1 AND 2000),
    internal_note text CHECK (length(internal_note) <= 4000),
    selection text,
    adoption_receipt text,
    opened_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK ((kind = 'correction') = (correction_of IS NOT NULL)),
    CHECK ((state = 'accepted') = (selection IS NOT NULL AND adoption_receipt IS NOT NULL)),
    CHECK (state NOT IN ('rejected', 'changes-requested') OR public_reason IS NOT NULL),
    CHECK (state <> 'deciding' OR decision_operation IS NOT NULL)
);
CREATE INDEX realm_submission_pending_page ON access.realm_submission (realm, opened_at, id)
    WHERE state IN ('pending', 'deciding');
CREATE INDEX realm_submission_pending_kind_page ON access.realm_submission (realm, kind, opened_at, id)
    WHERE state IN ('pending', 'deciding');
CREATE INDEX realm_submission_closed_page ON access.realm_submission (realm, opened_at, id)
    WHERE state IN ('accepted', 'rejected', 'changes-requested', 'withdrawn', 'stale');
CREATE INDEX realm_submission_closed_kind_page ON access.realm_submission (realm, kind, opened_at, id)
    WHERE state IN ('accepted', 'rejected', 'changes-requested', 'withdrawn', 'stale');
CREATE INDEX realm_submission_realm_page ON access.realm_submission (realm, state, kind, opened_at, id);
CREATE INDEX realm_submission_author_page ON access.realm_submission (submitting_agent, opened_at, id);
CREATE INDEX realm_submission_author_state_page ON access.realm_submission
    (submitting_agent, state, opened_at, id);
CREATE INDEX realm_submission_work_fk ON access.realm_submission (work);
CREATE INDEX realm_submission_decision_fk ON access.realm_submission (decision_operation);
CREATE INDEX realm_submission_reviewer_fk ON access.realm_submission (reviewer);

-- The reservation survives a crash between the graph adoption and SQL settlement.
-- Only the same admitted operation can finish it; a timeout never unlocks withdrawal.
CREATE TABLE access.realm_submission_operation (
    admission_id uuid PRIMARY KEY REFERENCES access.admission(id),
    submission_id uuid NOT NULL REFERENCES access.realm_submission(id),
    adoption jsonb,
    result jsonb
);
CREATE INDEX realm_submission_operation_submission ON access.realm_submission_operation (submission_id);
CREATE TABLE access.realm_submission_revision (
    revision uuid PRIMARY KEY,
    submission_id uuid NOT NULL REFERENCES access.realm_submission(id),
    generation bigint NOT NULL,
    snapshot jsonb NOT NULL,
    UNIQUE (submission_id, generation)
);
CREATE TABLE access.realm_submission_author_revision (
    agent text PRIMARY KEY REFERENCES access.authority_subject(id),
    revision bigint NOT NULL CHECK (revision >= 0)
);
CREATE FUNCTION access.realm_submission_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO access.realm_submission_revision VALUES (NEW.revision, NEW.id, NEW.generation, to_jsonb(NEW));
    PERFORM access.advance_realm_management_read_revision(NEW.realm);
    INSERT INTO access.realm_submission_author_revision VALUES (NEW.submitting_agent, 1)
        ON CONFLICT (agent) DO UPDATE SET revision = access.realm_submission_author_revision.revision + 1;
    RETURN NEW;
END $$;
CREATE TRIGGER realm_submission_changed AFTER INSERT OR UPDATE ON access.realm_submission
    FOR EACH ROW EXECUTE FUNCTION access.realm_submission_changed();
