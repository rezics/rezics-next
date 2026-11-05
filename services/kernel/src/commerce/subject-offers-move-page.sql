SELECT offer_id::text AS id FROM commerce.subject_offer_reference
WHERE route = :route::integer AND subject_id = :subject::uuid
 AND original_subject_id = :original::uuid AND offer_id > :after::uuid
ORDER BY offer_id LIMIT 100;
