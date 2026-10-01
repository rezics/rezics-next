-- Native precedence is one exact person probe after the merged candidate page,
-- independent of the target's retained observations and merge history.
CREATE INDEX rating_aggregate_native_person ON access.rating_aggregate_head
  (context, main_version, principal_id) WHERE target_release IS NULL;
