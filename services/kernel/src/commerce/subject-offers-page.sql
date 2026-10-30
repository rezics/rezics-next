SELECT offer_id::text AS "offerId", original_subject_id::text AS "originalSubjectId",
       source_revision AS "sourceRevision", identity_epoch::text AS "identityEpoch", listed
FROM commerce.subject_offer_reference
WHERE route = :route::integer AND subject_id = :subject::uuid AND offer_id > :after::uuid
ORDER BY offer_id LIMIT :limit::integer;
