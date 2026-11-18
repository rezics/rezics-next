SELECT k.page,k.item,e.receipt FROM jsonb_to_recordset(:coordinates::jsonb) k(page integer,item integer)
JOIN LATERAL (
  SELECT receipt FROM search.public_filter_repair_effect
  WHERE (partition_no,observation,execution,page,item)=
    (:partition_no::integer,:observation::text,:execution::text,k.page,k.item)
  OFFSET 0
) e ON true
ORDER BY k.page,k.item;
