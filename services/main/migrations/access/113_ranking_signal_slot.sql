-- Latest admitted signal weight per opaque rating slot inside one building
-- ranking generation. A coalesced batch replaces each slot's weight once and
-- applies only the candidate delta, so a hot target costs one score write per
-- batch and a replayed or older source position never counts twice. Slots are
-- the public relay's opaque identities; principals stay in Access inventory.
CREATE TABLE access.ranking_signal_slot (
    generation_id uuid NOT NULL REFERENCES access.ranking_generation(generation_id) ON DELETE CASCADE,
    slot text NOT NULL CHECK (slot ~ '^urn:rezics:rating-slot:[0-9a-f]{64}$'),
    candidate text NOT NULL CHECK (candidate ~ '^https://rezics[.]com/id/[0-9a-f-]{36}$'),
    weight numeric NOT NULL CHECK (weight >= 0),
    source_sequence numeric NOT NULL CHECK (source_sequence > 0 AND source_sequence = trunc(source_sequence)),
    source_event text NOT NULL CHECK (length(source_event) BETWEEN 1 AND 200),
    PRIMARY KEY (generation_id, slot)
);

CREATE TRIGGER ranking_signal_slot_insert_guard AFTER INSERT ON access.ranking_signal_slot
    REFERENCING NEW TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION access.derived_rows_guard();
CREATE TRIGGER ranking_signal_slot_update_guard AFTER UPDATE ON access.ranking_signal_slot
    REFERENCING NEW TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION access.derived_rows_guard();
CREATE TRIGGER ranking_signal_slot_delete_guard AFTER DELETE ON access.ranking_signal_slot
    REFERENCING OLD TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION access.derived_rows_guard();
