-- At most 100 native UUIDs from each account-leading child index, then a bounded merge.
SELECT id FROM (
  (SELECT entitlement_id AS id FROM commerce.entitlement
   WHERE route = :route::integer AND account_id = :account_id::uuid AND entitlement_id > :after::uuid
   ORDER BY entitlement_id LIMIT 100)
  UNION ALL
  (SELECT slot_id AS id FROM commerce.benefit_acquisition
   WHERE route = :route::integer AND buyer_account_id = :account_id::uuid AND slot_id > :after::uuid
   ORDER BY slot_id LIMIT 100)
) children ORDER BY id LIMIT 100;
