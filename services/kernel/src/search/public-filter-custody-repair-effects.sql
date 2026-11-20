-- Transfer only the leading range whose actual escaped bytes fit. The keyed
-- lookups examined by this query are bounded even when its output is empty.
WITH selected AS MATERIALIZED (
  SELECT k.item,e.receipt FROM unnest(:items::integer[]) WITH ORDINALITY k(item,ord)
  JOIN LATERAL (
    SELECT receipt FROM search.public_filter_repair_effect
    WHERE (partition_no,observation,execution,page,item)=
      (:partition_no::integer,:observation::text,:execution::text,:page::integer,k.item)
    OFFSET 0
  ) e ON true
), measured AS (
  SELECT item,receipt,sum(octet_length(to_json(receipt)::text)+128) OVER (ORDER BY item) AS bytes
  FROM selected
)
SELECT item,receipt FROM measured WHERE bytes<=:bytes::integer ORDER BY item;
