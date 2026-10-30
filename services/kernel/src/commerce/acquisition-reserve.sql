UPDATE commerce.benefit_acquisition SET order_id = :order_id
WHERE route = :route AND buyer_account_id = :buyer_account_id AND benefit = :benefit::text::jsonb;
