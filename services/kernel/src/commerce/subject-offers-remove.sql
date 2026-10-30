DELETE FROM commerce.subject_offer_reference
WHERE route = :route::integer AND subject_id = :subject::uuid AND offer_id = :offer::uuid
 AND original_subject_id = :original::uuid AND source_revision <= :revision::integer
 AND identity_epoch <= :epoch::bigint;
