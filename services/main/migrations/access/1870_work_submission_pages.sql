-- Equality prefixes precede the continuation, so an unrelated Work or author
-- cannot enlarge either a page read or its consistency fence.
CREATE INDEX realm_submission_author_work_page ON access.realm_submission
    (submitting_agent, work, opened_at, id);
CREATE INDEX realm_submission_author_work_state_page ON access.realm_submission
    (submitting_agent, work, state, opened_at, id);
CREATE INDEX realm_submission_realm_work_page ON access.realm_submission
    (realm, work, opened_at, id);
CREATE INDEX realm_submission_realm_work_state_page ON access.realm_submission
    (realm, work, state, opened_at, id);

CREATE TABLE access.realm_submission_work_revision (
    audience text NOT NULL,
    work text NOT NULL,
    revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
    PRIMARY KEY (audience, work)
);
CREATE FUNCTION access.realm_submission_work_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO access.realm_submission_work_revision (audience, work, revision)
        VALUES ('author:' || NEW.submitting_agent, NEW.work, 1), ('realm:' || NEW.realm, NEW.work, 1)
        ON CONFLICT (audience, work) DO UPDATE
        SET revision = access.realm_submission_work_revision.revision + 1;
    RETURN NEW;
END $$;
CREATE TRIGGER realm_submission_work_changed AFTER INSERT OR UPDATE ON access.realm_submission
    FOR EACH ROW EXECUTE FUNCTION access.realm_submission_work_changed();
