INSERT INTO rating.classification_aggregate
  (route, subject_id, association_id, binding_hash, support_count, oppose_count,
   false_positive_count, generation, as_of)
VALUES (:route::integer, :subject_id::uuid, :association_id::uuid, :binding_hash::bytea,
        :support_count::integer, :oppose_count::integer, :false_positive_count::integer,
        :generation::bigint, :as_of::timestamptz)
ON CONFLICT (route, subject_id, association_id, binding_hash) DO UPDATE
SET support_count = EXCLUDED.support_count,
    oppose_count = EXCLUDED.oppose_count,
    false_positive_count = EXCLUDED.false_positive_count,
    generation = EXCLUDED.generation,
    as_of = EXCLUDED.as_of;
