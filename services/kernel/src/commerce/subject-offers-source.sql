SELECT offer_id::text AS id FROM commerce.offer
WHERE (route >> 4) = :home::integer AND offer_id > :after::uuid
ORDER BY offer_id LIMIT 100;
