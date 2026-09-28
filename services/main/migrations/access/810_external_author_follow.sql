-- Readers follow Open Library authors as they follow REZICS Agents. An external
-- author has no REZICS IRI, so the relationship is keyed by provider and key
-- (`open-library:OL21594A`) in the same private head, receipt and inventory as
-- every other follow. Widened from 405_home_feed.sql, keeping every kind.
ALTER TABLE access.follow DROP CONSTRAINT follow_kind_check,
  ADD CONSTRAINT follow_kind_check
    CHECK (kind IN ('realm', 'zone', 'work', 'agent', 'external-author')),
  ADD CONSTRAINT follow_external_author_key
    CHECK ((kind = 'external-author') = (target ~ '^open-library:OL[1-9][0-9]{0,11}A$'));
