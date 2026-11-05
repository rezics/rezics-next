-- Detached formula composition consumes an already committed pre-Type interval.
-- This is an exact point and never scans votes, winners or subject payloads.
SELECT input.body, input.native_xid IS DISTINCT FROM pg_current_xact_id_if_assigned() AS committed
FROM library.collection_kind_raw_input input
JOIN library.collection_kind_audience_origin original
  ON (original.route,original.origin_id)=(input.route,input.origin_id)
JOIN library.collection_kind_observation observation
  ON (observation.route,observation.collection_id,observation.audience)=
     (original.route,original.collection_id,original.audience)
WHERE input.route=:route::integer AND input.input_id=:input_id::text
  AND input.origin_id=:origin_id::text AND input.preparation_id=:preparation_id::uuid
  AND original.owner_account_id=:owner_account_id::uuid AND original.collection_id=:collection_id::uuid
  AND input.observation_version=observation.version
  AND original.preparation_id=observation.generation AND NOT original.cancelled
LIMIT 1 FOR SHARE OF input;
