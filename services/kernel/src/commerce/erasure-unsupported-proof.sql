WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id
)
SELECT
  EXISTS (SELECT 1 FROM commerce.offer o, input i WHERE o.route=i.route AND o.creator_account_id=i.account_id)
  OR EXISTS (SELECT 1 FROM commerce.royalty_line r, input i WHERE r.route=i.route AND r.creator_account_id=i.account_id)
  OR EXISTS (SELECT 1 FROM commerce.payout_statement p, input i WHERE p.route=i.route AND p.creator_account_id=i.account_id)
  AS "unsupportedData";
