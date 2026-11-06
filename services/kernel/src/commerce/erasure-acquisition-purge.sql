DELETE FROM commerce.benefit_acquisition
WHERE route = :route AND buyer_account_id = :account_id AND slot_id = ANY(:ids::uuid[])
RETURNING slot_id AS id;
