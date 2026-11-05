INSERT INTO commerce.creator_sale
(route,creator_account_id,order_id,offer_id,target_subject_id,title,currency,unit_amount_minor,
 money_unit,tax_behavior,settlement,created_at,source_revision,source_transaction_id,
 source_epoch,source_position,source_event_seq,source_event_id)
VALUES (:route,:creator_account_id,:order_id,:offer_id,:target_subject_id,:title,:currency,:unit_amount_minor,
 NULLIF(:money_unit::text,'')::jsonb,NULLIF(:tax_behavior::text,''),:settlement,:created_at::timestamptz,
 :source_revision,:source_transaction_id,:source_epoch,:source_position,:source_event_seq,:source_event_id)
ON CONFLICT (route,creator_account_id,order_id) DO UPDATE SET
 settlement=EXCLUDED.settlement, source_revision=EXCLUDED.source_revision,
 source_transaction_id=EXCLUDED.source_transaction_id, source_epoch=EXCLUDED.source_epoch,
 source_position=EXCLUDED.source_position, source_event_seq=EXCLUDED.source_event_seq,
 source_event_id=EXCLUDED.source_event_id
WHERE commerce.creator_sale.source_revision < EXCLUDED.source_revision
  AND commerce.creator_sale.offer_id=EXCLUDED.offer_id
  AND commerce.creator_sale.target_subject_id=EXCLUDED.target_subject_id
  AND commerce.creator_sale.title=EXCLUDED.title AND commerce.creator_sale.currency=EXCLUDED.currency
  AND commerce.creator_sale.unit_amount_minor=EXCLUDED.unit_amount_minor
  AND commerce.creator_sale.money_unit IS NOT DISTINCT FROM EXCLUDED.money_unit
  AND commerce.creator_sale.tax_behavior IS NOT DISTINCT FROM EXCLUDED.tax_behavior
  AND commerce.creator_sale.created_at=EXCLUDED.created_at
RETURNING source_revision AS revision;
