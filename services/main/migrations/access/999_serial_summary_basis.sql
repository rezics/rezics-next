ALTER TABLE access.serial_summary ADD COLUMN main_version text;
ALTER TABLE access.serial_summary ADD COLUMN structure_head text;
ALTER TABLE access.serial_summary ADD COLUMN publication_head text;
ALTER TABLE access.serial_chapter ADD COLUMN publication text;
ALTER TABLE access.serial_chapter ADD COLUMN eligibility text;

-- Existing aggregates have no proof of the selected Structure/publication
-- they reduced. Replay retained owner batches into a qualified generation.
DELETE FROM access.serial_stats_checkpoint;
