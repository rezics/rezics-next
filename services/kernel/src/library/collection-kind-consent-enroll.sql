INSERT INTO library.collection_kind_consent_consumer
  (route,reference_id,owner_account_id,collection_id,preparation_id,origin_id,
   source_generation,capture_generation,source_capture,enrollment_generation,catalogue_root)
VALUES
  (:route::integer,:reference_id::text,:owner_account_id::uuid,:collection_id::uuid,
   :preparation_id::uuid,:origin_id::text,:source_generation::text::bigint,
   :capture_generation::uuid,:source_capture::text,:enrollment_generation::uuid,:catalogue_root::text)
ON CONFLICT DO NOTHING
RETURNING reference_id;
