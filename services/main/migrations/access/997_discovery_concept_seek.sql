-- Finalized with the immutable Discovery build, never aggregated during a read.
ALTER TABLE access.discovery_term_count ADD COLUMN concept_count bigint NOT NULL DEFAULT 0 CHECK (concept_count >= 0);
ALTER TABLE access.discovery_term_count ADD COLUMN concept_leader boolean NOT NULL DEFAULT false;
CREATE INDEX discovery_concept_popularity ON access.discovery_term_count
    (generation_id, concept_count DESC, concept COLLATE "C") WHERE concept_leader;
CREATE INDEX discovery_concept_identity ON access.discovery_term_count
    (generation_id, concept) WHERE concept_leader;
