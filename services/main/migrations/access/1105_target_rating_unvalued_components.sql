-- Operators list the targets that still wait for reconstruction without walking
-- every component row; only the few legacy targets carry unvalued heads.
CREATE INDEX target_rating_component_unvalued ON access.target_rating_component (context, target)
  WHERE unvalued > 0;
