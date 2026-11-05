SELECT
  EXISTS (SELECT 1 FROM commerce.offer WHERE route=:route AND creator_account_id=:account_id)
  OR EXISTS (SELECT 1 FROM commerce.royalty_line WHERE route=:route AND creator_account_id=:account_id)
  OR EXISTS (SELECT 1 FROM commerce.payout_statement WHERE route=:route AND creator_account_id=:account_id)
  AS "unsupportedData";
