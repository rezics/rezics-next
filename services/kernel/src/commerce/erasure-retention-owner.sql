SELECT o.buyer_account_id AS "buyerAccountId"
FROM commerce.purchase_order o
JOIN access.account a ON (a.route,a.account_id)=(o.route,o.buyer_account_id)
WHERE o.route=:route AND o.order_id=:order_id AND a.state='active'
  AND NOT EXISTS (SELECT 1 FROM access.erasure e WHERE (e.route,e.account_id)=(a.route,a.account_id))
FOR UPDATE OF a FOR SHARE OF o;
