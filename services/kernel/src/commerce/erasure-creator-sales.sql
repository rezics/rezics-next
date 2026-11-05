-- Disposable derived rows only; financial source roots and exact pending custody stay restricted.
-- One account-home raw100 page, including rows that arrived before the terminal fence.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id
), page AS MATERIALIZED (
  SELECT order_id FROM commerce.creator_sale, input
  WHERE commerce.creator_sale.route=input.route AND creator_account_id=input.account_id
  ORDER BY order_id LIMIT 100
), removed AS (
  DELETE FROM commerce.creator_sale USING input
  WHERE commerce.creator_sale.route=input.route AND creator_account_id=input.account_id
    AND order_id IN (SELECT order_id FROM page)
  RETURNING order_id
)
SELECT order_id AS id FROM removed;
