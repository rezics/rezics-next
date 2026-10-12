-- Classification commits while the principal still controls every live Person.
-- Root mandates and pending Person expansions each have an indexed frontier.
ALTER TABLE access.account_deletion_progress
    ADD COLUMN root_cursor uuid,
    ADD COLUMN open_principal_id uuid GENERATED ALWAYS AS (CASE WHEN NOT completed THEN principal_id END) STORED,
    ADD COLUMN expansion_cursor bigint NOT NULL DEFAULT 0,
    ADD COLUMN wake_cursor bigint NOT NULL DEFAULT 0,
    ADD COLUMN orphan_cursor text,
    ADD COLUMN roots_done boolean NOT NULL DEFAULT false,
    ADD COLUMN classification_done boolean NOT NULL DEFAULT false,
    ADD COLUMN consent boolean NOT NULL DEFAULT false,
    ADD COLUMN orphan_count integer NOT NULL DEFAULT 0,
    ADD COLUMN steps integer NOT NULL DEFAULT 0,
    ADD COLUMN needs_boundary_check boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX account_deletion_progress_open ON access.account_deletion_progress (open_principal_id)
    WHERE open_principal_id IS NOT NULL;
ALTER TABLE access.account_deletion_progress_agent
    ADD COLUMN expanded boolean NOT NULL DEFAULT false,
    ADD COLUMN expansion_rank bigint GENERATED ALWAYS AS IDENTITY,
    ADD COLUMN fenced boolean NOT NULL DEFAULT false;
UPDATE access.account_deletion_progress_agent a SET fenced = true
    FROM access.account_deletion_progress p WHERE p.operation_id = a.operation_id AND NOT p.completed;
CREATE UNIQUE INDEX account_deletion_live_fence ON access.account_deletion_progress_agent (agent_id) WHERE fenced;
CREATE INDEX account_deletion_fence_release ON access.account_deletion_progress_agent (operation_id, effect, agent_id) WHERE fenced;
CREATE INDEX account_deletion_root_frontier ON access.representation (principal_id, id)
    INCLUDE (subject_id) WHERE active AND action = 'agent.control';
CREATE INDEX account_deletion_foreign_controllers ON access.representation (subject_id, principal_id, id)
    WHERE active AND action = 'agent.control';
CREATE INDEX account_deletion_person_frontier
    ON access.account_deletion_progress_agent (operation_id, expansion_rank)
    WHERE effect = 'end' AND NOT expanded;
CREATE INDEX account_deletion_ending_inventory
    ON access.account_deletion_progress_agent (operation_id, effect, agent_id);
CREATE INDEX account_deletion_effect_pending
    ON access.account_deletion_progress_agent (operation_id, effect, agent_id) WHERE NOT completed;
CREATE INDEX account_deletion_orphan_preview
    ON access.account_deletion_progress_agent (operation_id, agent_id) WHERE effect >= 'orphan' AND effect <= 'orphan';
CREATE TABLE access.account_deletion_classification_frontier (
    wake_rank bigint GENERATED ALWAYS AS IDENTITY,
    operation_id text NOT NULL REFERENCES access.account_deletion_progress(operation_id),
    agent_id text NOT NULL REFERENCES access.authority_subject(id),
    PRIMARY KEY (operation_id, agent_id)
);
CREATE INDEX account_deletion_classification_wake_page
    ON access.account_deletion_classification_frontier (operation_id, wake_rank);
CREATE INDEX account_deletion_classification_frontier_subject
    ON access.account_deletion_classification_frontier (agent_id);

-- Index planning is part of the read budget, including when a small relation
-- would otherwise get a cached sequential scan. Function settings are scoped
-- to these owner operations and restore the caller's planner settings.
-- Preserve the leading range key in ORDER BY. Equality would let the planner
-- drop that key and scan the competing principal/subject index before filtering.
-- Seek only live mandates, never retained controller history. The owner drains
-- this index in bounded pages in the same transaction as principal deactivation.
-- Authority proofs continue to retain the original representation rows.
CREATE TABLE access.live_principal_controller (
    representation_id uuid PRIMARY KEY REFERENCES access.representation(id),
    principal_id uuid NOT NULL REFERENCES access.principal(id),
    subject_id text NOT NULL REFERENCES access.authority_subject(id)
);
CREATE INDEX live_principal_controller_subject ON access.live_principal_controller
    (subject_id, principal_id, representation_id);
CREATE INDEX live_principal_controller_principal ON access.live_principal_controller
    (principal_id, representation_id) INCLUDE (subject_id);
INSERT INTO access.live_principal_controller
    SELECT r.id, r.principal_id, r.subject_id FROM access.representation r
    JOIN access.principal p ON p.id = r.principal_id AND p.active
    WHERE r.active AND r.action = 'agent.control';

CREATE FUNCTION access.sync_live_principal_controller() RETURNS trigger LANGUAGE plpgsql SET enable_seqscan = off AS $$
BEGIN
    IF NEW.action <> 'agent.control' THEN RETURN NEW; END IF;
    IF NEW.active AND EXISTS (SELECT 1 FROM access.principal WHERE id = NEW.principal_id AND active) THEN
        INSERT INTO access.live_principal_controller VALUES (NEW.id, NEW.principal_id, NEW.subject_id)
            ON CONFLICT DO NOTHING;
    ELSE
        DELETE FROM access.live_principal_controller WHERE representation_id = NEW.id;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER representation_live_principal_controller AFTER INSERT OR UPDATE ON access.representation
    FOR EACH ROW EXECUTE FUNCTION access.sync_live_principal_controller();

CREATE INDEX account_deletion_continuity_recovery ON access.protected_change_activation
    (target_subject, activation_txid) WHERE kind = 'agent-recovery';

CREATE FUNCTION access.account_deletion_remaining_controllers(
    controlled text, deleting uuid, operation text)
RETURNS TABLE (remaining integer)
LANGUAGE sql STABLE SET enable_seqscan = off AS $$
    WITH below AS MATERIALIZED (
        SELECT principal_id FROM access.live_principal_controller
        WHERE subject_id >= controlled AND (subject_id, principal_id) < (controlled, deleting)
        ORDER BY subject_id DESC, principal_id DESC, representation_id DESC LIMIT 17
    ), above AS MATERIALIZED (
        SELECT principal_id FROM access.live_principal_controller
        WHERE subject_id <= controlled AND (subject_id, principal_id) > (controlled, deleting)
        ORDER BY subject_id, principal_id, representation_id LIMIT 17
    ), principals AS MATERIALIZED (
        SELECT principal_id FROM below UNION ALL SELECT principal_id FROM above
    ), edge_page AS MATERIALIZED (
        -- Admission bounds ACTIVE incoming edges to 16, including edges whose
        -- representative has ended. Page before testing representative liveness.
        SELECT representative_subject FROM access.representation_edge
        WHERE represented_subject >= controlled AND represented_subject <= controlled AND action = 'agent.control' AND active
        ORDER BY represented_subject, id LIMIT 17
    ), agents AS MATERIALIZED (
        SELECT e.representative_subject FROM edge_page e WHERE EXISTS (SELECT 1 FROM access.authority_subject s
            WHERE s.id = e.representative_subject AND s.active LIMIT 1 OFFSET 0)
    ) SELECT ((SELECT count(*) FROM principals)
        + (SELECT count(*) FROM agents e WHERE NOT EXISTS (
            SELECT 1 FROM access.account_deletion_progress_agent a
            WHERE a.operation_id = operation AND a.agent_id = e.representative_subject
                AND a.effect = 'end' LIMIT 1 OFFSET 0)))::integer
$$;

CREATE OR REPLACE FUNCTION access.agent_controller_count(controlled text) RETURNS integer
LANGUAGE sql STABLE SET enable_seqscan = off AS $$
    WITH principals AS MATERIALIZED (
        SELECT representation_id FROM access.live_principal_controller
        WHERE subject_id >= controlled AND subject_id <= controlled
            ORDER BY subject_id, principal_id, representation_id LIMIT 17
    ), edges AS MATERIALIZED (
        SELECT representative_subject FROM access.representation_edge
        WHERE represented_subject >= controlled AND represented_subject <= controlled AND action = 'agent.control' AND active
        ORDER BY represented_subject, id LIMIT 17
    ) SELECT (SELECT count(*) FROM principals)::integer + (SELECT count(*) FROM edges e WHERE EXISTS (SELECT 1 FROM access.authority_subject s
            WHERE s.id = e.representative_subject AND s.active LIMIT 1 OFFSET 0))::integer
$$;

-- A cut is not fenced. If an ordinary controller change makes it affected
-- between steps, wake precisely that subject rather than replaying old levels.
CREATE FUNCTION access.queue_account_deletion_candidate(controlled text) RETURNS void
LANGUAGE sql SET enable_seqscan = off AS $$
    WITH principals AS MATERIALIZED (
        SELECT principal_id FROM access.live_principal_controller WHERE subject_id >= controlled AND subject_id <= controlled
            ORDER BY subject_id, principal_id, representation_id LIMIT 17
    ), edges AS MATERIALIZED (
        SELECT representative_subject FROM access.representation_edge
        WHERE represented_subject >= controlled AND represented_subject <= controlled AND action = 'agent.control' AND active
        ORDER BY represented_subject, id LIMIT 17
    ), relevant AS MATERIALIZED (
        SELECT DISTINCT p.operation_id, p.principal_id FROM (
            SELECT p.operation_id FROM principals r
            CROSS JOIN LATERAL (SELECT operation_id FROM access.account_deletion_progress
                WHERE open_principal_id = r.principal_id LIMIT 1 OFFSET 0) p
            UNION
            SELECT a.operation_id FROM edges e
            CROSS JOIN LATERAL (SELECT operation_id FROM access.account_deletion_progress_agent
                WHERE agent_id = e.representative_subject AND effect = 'end' AND fenced LIMIT 1 OFFSET 0) a
        ) connected CROSS JOIN LATERAL (SELECT operation_id, principal_id, completed
            FROM access.account_deletion_progress WHERE operation_id = connected.operation_id LIMIT 1 OFFSET 0) p
        WHERE NOT p.completed AND EXISTS (SELECT 1 FROM access.authority_subject s WHERE s.id = controlled AND s.active)
            AND NOT EXISTS (SELECT 1 FROM access.account_deletion_progress_agent a
                WHERE a.operation_id = p.operation_id AND a.agent_id = controlled LIMIT 1 OFFSET 0)
    ), queued AS (
        INSERT INTO access.account_deletion_classification_frontier (operation_id, agent_id)
        SELECT r.operation_id, controlled FROM relevant r
        CROSS JOIN LATERAL access.account_deletion_remaining_controllers(
            controlled, r.principal_id, r.operation_id) c
        WHERE c.remaining = 0
        ON CONFLICT DO NOTHING RETURNING operation_id
    ) UPDATE access.account_deletion_progress p SET classification_done = false
        WHERE p.ctid = ANY(ARRAY(SELECT p.ctid FROM queued q
          CROSS JOIN LATERAL (SELECT ctid FROM access.account_deletion_progress
            WHERE operation_id = q.operation_id LIMIT 1 OFFSET 0) p))
$$;

CREATE FUNCTION access.wake_account_deletion_frontier() RETURNS trigger
LANGUAGE plpgsql SET enable_seqscan = off AS $$
DECLARE controlled text;
BEGIN
    IF TG_TABLE_NAME = 'authority_subject' THEN
        IF NEW.active OR NOT OLD.active THEN RETURN NEW; END IF;
        FOR controlled IN SELECT represented_subject FROM access.representation_edge
            WHERE representative_subject >= NEW.id AND representative_subject <= NEW.id AND active AND action = 'agent.control'
                AND valid_until > clock_timestamp() ORDER BY representative_subject, action, id LIMIT 16
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
CREATE TRIGGER representation_z_wake_account_deletion_frontier AFTER INSERT OR UPDATE ON access.representation
    FOR EACH ROW EXECUTE FUNCTION access.wake_account_deletion_frontier();
CREATE TRIGGER representation_edge_wake_account_deletion_frontier AFTER INSERT OR UPDATE ON access.representation_edge
    FOR EACH ROW EXECUTE FUNCTION access.wake_account_deletion_frontier();
CREATE TRIGGER authority_subject_wake_account_deletion_frontier AFTER UPDATE OF active ON access.authority_subject
    FOR EACH ROW EXECUTE FUNCTION access.wake_account_deletion_frontier();

-- A deleted live mandate wakes only connected open operations, through point
-- lookups after bounded live-controller ranges, even with many unrelated erasures.
CREATE FUNCTION access.guard_removed_principal_controller() RETURNS trigger LANGUAGE plpgsql SET enable_seqscan = off AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM access.account_deletion_progress_agent a
        CROSS JOIN LATERAL (SELECT principal_id FROM access.account_deletion_progress
            WHERE operation_id = a.operation_id LIMIT 1 OFFSET 0) p
        WHERE a.agent_id = OLD.subject_id AND a.fenced AND p.principal_id <> OLD.principal_id) THEN
        RAISE EXCEPTION 'Account deletion control inventory is fenced' USING ERRCODE = '54000';
    END IF;
    RETURN OLD;
END $$;
CREATE TRIGGER live_principal_controller_guard BEFORE DELETE ON access.live_principal_controller
    FOR EACH ROW EXECUTE FUNCTION access.guard_removed_principal_controller();

CREATE FUNCTION access.wake_removed_principal_controller() RETURNS trigger LANGUAGE plpgsql SET enable_seqscan = off AS $$
BEGIN
    PERFORM access.queue_account_deletion_candidate(OLD.subject_id);
    RETURN OLD;
END $$;
CREATE TRIGGER live_principal_controller_removed AFTER DELETE ON access.live_principal_controller
    FOR EACH ROW EXECUTE FUNCTION access.wake_removed_principal_controller();

CREATE FUNCTION access.retire_principal_controller_page(deleting uuid, budget integer, after_id uuid DEFAULT NULL)
RETURNS TABLE (removals integer, cursor uuid) LANGUAGE sql SET enable_seqscan = off AS $$
    WITH page AS MATERIALIZED (
        SELECT representation_id, ctid FROM access.live_principal_controller WHERE principal_id >= deleting AND principal_id <= deleting
            AND representation_id >= coalesce(after_id, '00000000-0000-0000-0000-000000000000'::uuid)
            AND (after_id IS NULL OR representation_id > after_id)
        ORDER BY principal_id, representation_id LIMIT least(budget, 256)
    ), removed AS (
        DELETE FROM access.live_principal_controller
        WHERE ctid = ANY(ARRAY(SELECT ctid FROM page)) RETURNING representation_id
    ) SELECT (SELECT count(*)::integer FROM removed),
        (SELECT representation_id FROM page ORDER BY representation_id DESC LIMIT 1)
$$;

-- Ordinary fences already have a 256-subject owner budget. The large deletion
-- owner drains its own mandate index before this update. The trigger never
-- replays an unbounded mandate inventory because an unrelated erasure is open.
CREATE FUNCTION access.principal_live_controller_transition() RETURNS trigger LANGUAGE plpgsql SET enable_seqscan = off AS $$
DECLARE inventory integer;
BEGIN
    IF NEW.active = OLD.active THEN RETURN NEW; END IF;
    IF NOT NEW.active THEN
        SELECT count(*) INTO inventory FROM (SELECT 1 FROM access.live_principal_controller
            WHERE principal_id >= NEW.id AND principal_id <= NEW.id
            ORDER BY principal_id, representation_id LIMIT 257) bounded;
        IF inventory > 256 THEN
            RAISE EXCEPTION 'principal controller change requires paged retirement' USING ERRCODE = '54000';
        END IF;
        PERFORM access.retire_principal_controller_page(NEW.id, 256);
    ELSE
        SELECT count(*) INTO inventory FROM (SELECT 1 FROM access.representation
            WHERE principal_id = NEW.id AND active AND action = 'agent.control' ORDER BY id LIMIT 257) bounded;
        IF inventory > 256 THEN
            RAISE EXCEPTION 'principal controller restoration exceeds its subject budget' USING ERRCODE = '54000';
        END IF;
        INSERT INTO access.live_principal_controller
            SELECT id, principal_id, subject_id FROM access.representation
            WHERE principal_id = NEW.id AND active AND action = 'agent.control' ORDER BY id LIMIT 256
            ON CONFLICT DO NOTHING;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER principal_z_live_controller_transition BEFORE UPDATE OF active ON access.principal
    FOR EACH ROW EXECUTE FUNCTION access.principal_live_controller_transition();

CREATE OR REPLACE FUNCTION access.fence_account_deletion_control() RETURNS trigger LANGUAGE plpgsql SET enable_seqscan = off AS $$
DECLARE subjects text[];
BEGIN
    IF TG_TABLE_NAME = 'principal' THEN
        -- The owner checks each retiring mandate in its paged retirement. The
        -- final UPDATE reads only this principal's open operation, never others.
        IF NEW.active OR NOT OLD.active THEN RETURN NEW; END IF;
        IF EXISTS (SELECT 1 FROM access.account_deletion_progress WHERE open_principal_id = NEW.id) THEN
            RAISE EXCEPTION 'Account deletion control inventory is fenced' USING ERRCODE = '54000';
        END IF;
        RETURN NEW;
    ELSIF TG_TABLE_NAME = 'agent_control' THEN subjects := ARRAY[NEW.subject_id];
    ELSIF TG_TABLE_NAME = 'representation' THEN
        IF NEW.action <> 'agent.control' THEN RETURN NEW; END IF;
        subjects := ARRAY[NEW.subject_id];
    ELSE
        IF NEW.action <> 'agent.control' THEN RETURN NEW; END IF;
        subjects := ARRAY[NEW.representative_subject, NEW.represented_subject];
    END IF;
    PERFORM 1 FROM access.scope_gate WHERE id = 'access:representation-topology' FOR UPDATE;
    IF EXISTS (SELECT 1 FROM access.account_deletion_progress_agent WHERE agent_id = ANY(subjects) AND fenced) THEN
        RAISE EXCEPTION 'Account deletion control inventory is fenced' USING ERRCODE = '54000';
    END IF;
    RETURN NEW;
END $$;

-- Preserve inventories admitted under the previous release's fence-first flow.
UPDATE access.account_deletion_progress p SET roots_done = true, classification_done = true, consent = true,
    orphan_count = (SELECT count(*) FROM access.account_deletion_progress_agent a
        WHERE a.operation_id = p.operation_id AND a.effect = 'orphan')
    WHERE EXISTS (SELECT 1 FROM access.principal s WHERE s.id = p.principal_id AND NOT s.active);
UPDATE access.account_deletion_progress_agent a SET expanded = true
    FROM access.account_deletion_progress p WHERE p.operation_id = a.operation_id AND p.classification_done;
