-- Classification commits while the principal still controls every live Person.
-- Root mandates and pending Person expansions each have an indexed frontier.
ALTER TABLE access.account_deletion_progress
    ADD COLUMN root_cursor uuid,
    ADD COLUMN roots_done boolean NOT NULL DEFAULT false,
    ADD COLUMN classification_done boolean NOT NULL DEFAULT false,
    ADD COLUMN consent boolean NOT NULL DEFAULT false,
    ADD COLUMN orphan_count integer NOT NULL DEFAULT 0,
    ADD COLUMN steps integer NOT NULL DEFAULT 0,
    ADD COLUMN needs_boundary_check boolean NOT NULL DEFAULT false;
CREATE INDEX account_deletion_progress_open ON access.account_deletion_progress (principal_id, operation_id)
    WHERE NOT completed;
ALTER TABLE access.account_deletion_progress_agent
    ADD COLUMN expanded boolean NOT NULL DEFAULT false;
CREATE INDEX account_deletion_root_frontier ON access.representation (principal_id, id)
    INCLUDE (subject_id) WHERE active AND action = 'agent.control';
CREATE INDEX account_deletion_foreign_controllers ON access.representation (subject_id, principal_id, id)
    WHERE active AND action = 'agent.control';
CREATE INDEX account_deletion_person_frontier
    ON access.account_deletion_progress_agent (operation_id, agent_id)
    WHERE effect = 'end' AND NOT expanded;
CREATE INDEX account_deletion_effect_pending
    ON access.account_deletion_progress_agent (operation_id, effect, agent_id) WHERE NOT completed;
CREATE INDEX account_deletion_orphan_preview
    ON access.account_deletion_progress_agent (operation_id, agent_id) WHERE effect = 'orphan';
CREATE TABLE access.account_deletion_classification_frontier (
    operation_id text NOT NULL REFERENCES access.account_deletion_progress(operation_id),
    agent_id text NOT NULL REFERENCES access.authority_subject(id),
    PRIMARY KEY (operation_id, agent_id)
);
CREATE INDEX account_deletion_classification_frontier_subject
    ON access.account_deletion_classification_frontier (agent_id);

-- Exclude the deleting principal before either indexed controller range. Its
-- repeated mandates must never hide a foreign controller behind a row budget.
-- A surviving Agent edge cuts traversal even when that Agent is a Person. Keep accounting
-- in the owner so tests can measure actual inventory rows, independent of time.
CREATE FUNCTION access.account_deletion_remaining_controllers(
    controlled text, deleting uuid, operation text)
RETURNS TABLE (remaining integer, controller_rows integer)
LANGUAGE sql STABLE AS $$
    WITH below AS MATERIALIZED (
        SELECT r.principal_id FROM access.representation r
        JOIN access.principal p ON p.id = r.principal_id AND p.active
        WHERE r.subject_id = controlled AND r.action = 'agent.control' AND r.active
            AND r.principal_id < deleting
        ORDER BY r.principal_id, r.id LIMIT 17
    ), above AS MATERIALIZED (
        SELECT r.principal_id FROM access.representation r
        JOIN access.principal p ON p.id = r.principal_id AND p.active
        WHERE r.subject_id = controlled AND r.action = 'agent.control' AND r.active
            AND r.principal_id > deleting
        ORDER BY r.principal_id, r.id LIMIT 17
    ), principals AS MATERIALIZED (
        SELECT principal_id FROM below UNION ALL SELECT principal_id FROM above
    ), agents AS MATERIALIZED (
        SELECT e.representative_subject FROM access.representation_edge e
        JOIN access.authority_subject s ON s.id = e.representative_subject AND s.active
        WHERE e.represented_subject = controlled AND e.action = 'agent.control'
            AND e.active AND e.valid_until > clock_timestamp()
        ORDER BY e.id LIMIT 17
    ) SELECT ((SELECT count(*) FROM principals)
        + (SELECT count(*) FROM agents e WHERE NOT EXISTS (
            SELECT 1 FROM access.account_deletion_progress_agent a
            WHERE a.operation_id = operation AND a.agent_id = e.representative_subject
                AND a.effect = 'end')))::integer,
        ((SELECT count(*) FROM principals) + (SELECT count(*) FROM agents))::integer
$$;

-- A cut is not fenced. If an ordinary controller change makes it affected
-- between steps, wake precisely that subject rather than replaying old levels.
CREATE FUNCTION access.queue_account_deletion_candidate(controlled text) RETURNS void
LANGUAGE sql AS $$
    WITH relevant AS MATERIALIZED (
        SELECT DISTINCT p.operation_id, p.principal_id FROM (
            SELECT p.operation_id FROM access.representation r
            JOIN access.account_deletion_progress p ON p.principal_id = r.principal_id AND NOT p.completed
            WHERE r.subject_id = controlled AND r.active AND r.action = 'agent.control'
            UNION
            SELECT a.operation_id FROM access.representation_edge e
            JOIN access.account_deletion_progress_agent a ON a.agent_id = e.representative_subject AND a.effect = 'end'
            WHERE e.represented_subject = controlled AND e.action = 'agent.control'
                AND e.active AND e.valid_until > clock_timestamp()
        ) connected JOIN access.account_deletion_progress p USING (operation_id)
        WHERE NOT p.completed AND NOT EXISTS (SELECT 1 FROM access.account_deletion_progress_agent a
                WHERE a.operation_id = p.operation_id AND a.agent_id = controlled)
    ), queued AS (
        INSERT INTO access.account_deletion_classification_frontier (operation_id, agent_id)
        SELECT r.operation_id, controlled FROM relevant r
        CROSS JOIN LATERAL access.account_deletion_remaining_controllers(
            controlled, r.principal_id, r.operation_id) c
        WHERE c.remaining = 0
        ON CONFLICT DO NOTHING RETURNING operation_id
    ) UPDATE access.account_deletion_progress p SET classification_done = false
        WHERE p.operation_id IN (SELECT operation_id FROM queued)
$$;

CREATE FUNCTION access.wake_account_deletion_frontier() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE controlled text;
BEGIN
    -- Ordinary writes do not enter the frontier planner without an open deletion.
    IF NOT EXISTS (SELECT 1 FROM access.account_deletion_progress WHERE NOT completed) THEN
        RETURN NEW;
    END IF;
    IF TG_TABLE_NAME = 'principal' THEN
        IF NEW.active OR NOT OLD.active THEN RETURN NEW; END IF;
        FOR controlled IN SELECT subject_id FROM access.representation
            WHERE principal_id = NEW.id AND active AND action = 'agent.control'
        LOOP PERFORM access.queue_account_deletion_candidate(controlled); END LOOP;
    ELSIF TG_TABLE_NAME = 'authority_subject' THEN
        IF NEW.active OR NOT OLD.active THEN RETURN NEW; END IF;
        FOR controlled IN SELECT represented_subject FROM access.representation_edge
            WHERE representative_subject = NEW.id AND active AND action = 'agent.control'
                AND valid_until > clock_timestamp() ORDER BY id LIMIT 16
        LOOP PERFORM access.queue_account_deletion_candidate(controlled); END LOOP;
    ELSIF TG_TABLE_NAME = 'representation' THEN
        IF NEW.action = 'agent.control' THEN
            PERFORM access.queue_account_deletion_candidate(NEW.subject_id);
        END IF;
    ELSIF NEW.action = 'agent.control' THEN
        PERFORM access.queue_account_deletion_candidate(NEW.represented_subject);
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER principal_wake_account_deletion_frontier AFTER UPDATE OF active ON access.principal
    FOR EACH ROW EXECUTE FUNCTION access.wake_account_deletion_frontier();
CREATE TRIGGER representation_wake_account_deletion_frontier AFTER INSERT OR UPDATE ON access.representation
    FOR EACH ROW EXECUTE FUNCTION access.wake_account_deletion_frontier();
CREATE TRIGGER representation_edge_wake_account_deletion_frontier AFTER INSERT OR UPDATE ON access.representation_edge
    FOR EACH ROW EXECUTE FUNCTION access.wake_account_deletion_frontier();
CREATE TRIGGER authority_subject_wake_account_deletion_frontier AFTER UPDATE OF active ON access.authority_subject
    FOR EACH ROW EXECUTE FUNCTION access.wake_account_deletion_frontier();

-- Preserve inventories admitted under the previous release's fence-first flow.
UPDATE access.account_deletion_progress p SET roots_done = true, classification_done = true, consent = true,
    orphan_count = (SELECT count(*) FROM access.account_deletion_progress_agent a
        WHERE a.operation_id = p.operation_id AND a.effect = 'orphan')
    WHERE EXISTS (SELECT 1 FROM access.principal s WHERE s.id = p.principal_id AND NOT s.active);
UPDATE access.account_deletion_progress_agent a SET expanded = true
    FROM access.account_deletion_progress p WHERE p.operation_id = a.operation_id AND p.classification_done;
