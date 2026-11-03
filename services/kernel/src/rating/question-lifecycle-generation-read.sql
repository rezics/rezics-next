SELECT COALESCE(
         (SELECT generation::text FROM rating.question_lifecycle_generation WHERE realm_id = :realm_id::uuid),
         '0'
       ) AS generation;
