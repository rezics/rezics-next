-- Readers follow a Concept: its one-Condition Filter over the Concept Facet
-- (docs/contracts/queries.md#concepts-and-value-pages). The target is the
-- Concept's IRI, in the same private head, receipt and inventory as every other
-- follow. Widened from 810_external_author_follow.sql, keeping every kind.
ALTER TABLE access.follow DROP CONSTRAINT follow_kind_check,
  ADD CONSTRAINT follow_kind_check
    CHECK (kind IN ('realm', 'zone', 'work', 'agent', 'external-author', 'concept'));
