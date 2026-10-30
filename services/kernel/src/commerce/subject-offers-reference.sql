SELECT version::text AS version FROM commerce.subject_offer_reference
WHERE route = :route::integer AND subject_id = :subject::uuid AND offer_id = :offer::uuid;
