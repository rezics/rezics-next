-- A member anchor indexes a chapter on its enclosing series under one
-- continuity key derived from both Structures' orders. The member Structure's
-- scope records the heads and enclosing Structure its anchors were prepared
-- for, so a change to either one leaves them unprepared until a bounded
-- background pass rewrites them. A NULL basis is unprepared, which includes
-- every scope that predates anchors.
ALTER TABLE structure.progress_scope
  ADD COLUMN anchor_revision text, ADD COLUMN anchor_parent text,
  ADD COLUMN anchor_parent_revision text, ADD COLUMN anchor_cursor jsonb,
  ADD CONSTRAINT progress_scope_anchor_basis CHECK (
    (anchor_revision IS NULL) = (anchor_parent IS NULL)
    AND (anchor_revision IS NULL) = (anchor_parent_revision IS NULL));
