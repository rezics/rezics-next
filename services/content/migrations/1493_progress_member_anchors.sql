-- A member anchor indexes a chapter on one Structure that encloses its Work,
-- under one continuity key derived from both Structures' orders. A member can
-- be enclosed by several compositions (a series and an omnibus), so each
-- (member Structure, enclosing Structure) pair keeps its own basis: the heads
-- its anchors were prepared for and the cursor of a pass still writing them.
-- A NULL revision is unprepared, which includes every pair that predates
-- anchors and every pair whose placement was lost: a bounded background pass
-- re-prepares it, or withdraws its anchors when the enclosing Structure no
-- longer holds the member, then deletes the row.
-- The empty parent is the member's overflow mark: it was enclosed by more
-- compositions than it keeps anchors for, so a composition that holds it
-- without an anchor answers resume as unavailable instead of unread.
CREATE TABLE structure.progress_anchor_scope (
  principal_issuer text NOT NULL, principal_subject text NOT NULL,
  structure text NOT NULL, parent text NOT NULL,
  revision text, parent_revision text, cursor jsonb,
  PRIMARY KEY (principal_issuer, principal_subject, structure, parent),
  CONSTRAINT progress_anchor_scope_basis CHECK ((revision IS NULL) = (parent_revision IS NULL))
);
CREATE INDEX progress_anchor_overflow ON structure.progress_anchor_scope
  (principal_issuer, principal_subject, structure) WHERE parent = '';
