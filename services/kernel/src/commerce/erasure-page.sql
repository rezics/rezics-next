-- At most 100 native UUIDs from each account-leading child index, then a bounded merge.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id, :after::uuid AS after
)
SELECT id FROM (
  (SELECT entitlement_id AS id FROM commerce.entitlement
   WHERE route = (SELECT route FROM input) AND account_id = (SELECT account_id FROM input)
     AND entitlement_id > (SELECT after FROM input)
   ORDER BY entitlement_id LIMIT 100)
  UNION ALL
  (SELECT slot_id AS id FROM commerce.benefit_acquisition
   WHERE route = (SELECT route FROM input) AND buyer_account_id = (SELECT account_id FROM input)
     AND slot_id > (SELECT after FROM input)
   ORDER BY slot_id LIMIT 100)
) children ORDER BY id LIMIT 100;
