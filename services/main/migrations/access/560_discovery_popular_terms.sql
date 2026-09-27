-- The build owns Work-grain term counts. GET reads only the selected generation's
-- top bounded rows; it never aggregates the discovery entry population.
CREATE TABLE access.discovery_term_count (
    generation_id uuid NOT NULL REFERENCES access.discovery_generation(generation_id) ON DELETE CASCADE,
    term text COLLATE "C" NOT NULL CHECK (term ~ '^https://rezics[.]com/id/[0-9a-f-]{36}$'),
    concept text NOT NULL CHECK (concept ~ '^https://rezics[.]com/id/[0-9a-f-]{36}$'),
    work_count bigint NOT NULL CHECK (work_count > 0),
    PRIMARY KEY (generation_id, term)
);
CREATE INDEX discovery_term_popularity ON access.discovery_term_count
    (generation_id, work_count DESC, term COLLATE "C");

CREATE TRIGGER discovery_term_insert_guard AFTER INSERT ON access.discovery_term_count
    REFERENCING NEW TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION access.derived_rows_guard();
CREATE TRIGGER discovery_term_update_guard AFTER UPDATE ON access.discovery_term_count
    REFERENCING NEW TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION access.derived_rows_guard();
CREATE TRIGGER discovery_term_delete_guard AFTER DELETE ON access.discovery_term_count
    REFERENCING OLD TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION access.derived_rows_guard();
