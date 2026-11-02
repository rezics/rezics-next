INSERT INTO library.collection_kind_raw_input
  (route,origin_id,preparation_id,observation_version,input_id,predecessor,body)
VALUES (:route::integer,:origin_id::text,:preparation_id::uuid,:version::text::bigint,
        :input_id::text,:predecessor::nullable(text),:body::text)
ON CONFLICT DO NOTHING
RETURNING input_id AS "inputId";
