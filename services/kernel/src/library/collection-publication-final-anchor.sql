SELECT EXISTS (
  SELECT 1 FROM library.collection
  WHERE route = :route AND collection_id = :collection_id
    AND curator_account_id = :owner_account_id AND state = 'active'
    AND membership_kind = 'dynamic'
) AS valid;
