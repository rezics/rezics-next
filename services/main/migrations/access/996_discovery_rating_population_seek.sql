-- Discover seeks effective rating inheritance by target, independent of Context.
CREATE INDEX rating_merge_selection_target_context
  ON access.rating_merge_selection (main_version, context, principal_id);
