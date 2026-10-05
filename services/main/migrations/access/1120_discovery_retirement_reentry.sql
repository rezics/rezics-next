-- Purging a superseded population leaves its durable generation/receipts intact.
-- A later activation may expire that generation; there is then nothing left to
-- retire. Probe by primary key under the activation/purge scope lock, so already
-- purged populations cannot make every future activation fail its foreign key.
CREATE OR REPLACE FUNCTION access.retire_discovery_entries() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.family='discovery' AND NEW.state IN ('cancelled','failed','superseded','expired') THEN
        INSERT INTO access.discovery_retirement (generation_id,due_at)
            SELECT generation_id,NEW.finished_at+interval '6 minutes'
            FROM access.discovery_generation WHERE generation_id=NEW.id
            ON CONFLICT (generation_id) DO UPDATE SET due_at=least(access.discovery_retirement.due_at,EXCLUDED.due_at);
    END IF;
    RETURN NULL;
END $$;
