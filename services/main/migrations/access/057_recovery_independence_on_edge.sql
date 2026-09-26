-- A recovery authority must remain independent when a controller edge is
-- added after its Agent control policy. The topology gate from migration 050
-- serializes this check with all other edge writes. The reverse and forward
-- walks are bounded to 256 subjects each; a larger topology refuses expansion.
CREATE FUNCTION access.check_recovery_independence_on_edge() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE ancestors integer; descendants integer; compromised boolean;
BEGIN
    IF NEW.action <> 'agent.control' OR NOT NEW.active THEN RETURN NEW; END IF;
    WITH RECURSIVE reverse_path(subject) AS (
        SELECT NEW.representative_subject
        UNION
        SELECT e.representative_subject FROM access.representation_edge e
        JOIN reverse_path path ON path.subject = e.represented_subject
        WHERE e.active AND e.action = 'agent.control'
            AND e.valid_until > clock_timestamp()
    ), forward_path(subject) AS (
        SELECT NEW.represented_subject
        UNION
        SELECT e.represented_subject FROM access.representation_edge e
        JOIN forward_path path ON path.subject = e.representative_subject
        WHERE e.active AND e.action = 'agent.control'
            AND e.valid_until > clock_timestamp()
    ), ancestors AS (
        SELECT subject FROM reverse_path LIMIT 257
    ), descendants AS (
        SELECT subject FROM forward_path LIMIT 257
    )
    SELECT (SELECT count(*) FROM ancestors), (SELECT count(*) FROM descendants),
        EXISTS (SELECT 1 FROM access.agent_control c
            JOIN ancestors a ON a.subject = c.subject_id
            JOIN descendants d ON d.subject = c.recovery_subject)
        INTO ancestors, descendants, compromised;
    IF ancestors > 256 OR descendants > 256 THEN
        RAISE EXCEPTION 'agent recovery independence walk limit' USING ERRCODE = '54000';
    END IF;
    IF compromised THEN
        RAISE EXCEPTION 'recovery authority is controlled by its Agent'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER representation_edge_recovery_independence
    BEFORE INSERT ON access.representation_edge FOR EACH ROW
    EXECUTE FUNCTION access.check_recovery_independence_on_edge();
