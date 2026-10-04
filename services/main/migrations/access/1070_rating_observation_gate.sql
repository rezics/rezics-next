-- The authority scope remains rating:observe:<Context>. Independent targets
-- share its fence and take an exclusive inventory gate only for their target.
CREATE TABLE access.rating_observation_gate (
  context text NOT NULL,
  target text NOT NULL,
  PRIMARY KEY (context, target)
);

-- Ranking priors now use only the caller's readable requested members. The
-- Context totals no longer serve a read and needlessly couple independent seals.
DROP TABLE access.target_rating_context_component;

-- Reconstruction pages only the unvalued legacy heads, in slot order.
CREATE INDEX target_rating_unvalued_slot ON access.target_rating_head (context, target, slot)
  WHERE NOT value_known;
