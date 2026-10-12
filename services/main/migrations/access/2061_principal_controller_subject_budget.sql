-- Principal fencing is bounded by distinct Agents, as principalControllerSubjects
-- defines it. Multiple controller mandates on one Agent consume one subject.
CREATE INDEX live_principal_controller_principal_subject
    ON access.live_principal_controller (principal_id, subject_id, representation_id);
CREATE INDEX representation_principal_controller_subject
    ON access.representation (principal_id, subject_id, id)
    WHERE active AND action = 'agent.control';

CREATE OR REPLACE FUNCTION access.principal_live_controller_transition() RETURNS trigger
LANGUAGE plpgsql SET enable_seqscan = off AS $$
DECLARE
    inventory integer;
    retired record;
    after_id uuid;
BEGIN
    IF NEW.active = OLD.active THEN RETURN NEW; END IF;
    IF NOT NEW.active THEN
        SELECT count(*) INTO inventory FROM (SELECT DISTINCT principal_id, subject_id
            FROM access.live_principal_controller
            WHERE principal_id >= NEW.id AND principal_id <= NEW.id
            ORDER BY principal_id, subject_id LIMIT 257) bounded;
        IF inventory > 256 THEN
            RAISE EXCEPTION 'principal controller change requires paged retirement' USING ERRCODE = '54000';
        END IF;
        -- Subject admission bounds the inventory; retire every mandate on those
        -- subjects rather than truncating the live index at 256 mandates.
        LOOP
            SELECT * INTO retired FROM access.retire_principal_controller_page(NEW.id, 256, after_id);
            EXIT WHEN retired.removals < 256;
            after_id := retired.cursor;
        END LOOP;
    ELSE
        SELECT count(*) INTO inventory FROM (SELECT DISTINCT principal_id, subject_id FROM access.representation
            WHERE principal_id >= NEW.id AND principal_id <= NEW.id AND active AND action = 'agent.control'
            ORDER BY principal_id, subject_id LIMIT 257) bounded;
        IF inventory > 256 THEN
            RAISE EXCEPTION 'principal controller restoration exceeds its subject budget' USING ERRCODE = '54000';
        END IF;
        INSERT INTO access.live_principal_controller
            SELECT id, principal_id, subject_id FROM access.representation
            WHERE principal_id >= NEW.id AND principal_id <= NEW.id AND active AND action = 'agent.control'
            ON CONFLICT DO NOTHING;
    END IF;
    RETURN NEW;
END $$;
