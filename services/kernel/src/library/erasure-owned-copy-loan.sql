-- Repeated bounded deletion of the first remaining loan key; private payload is never a work result.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id
), keys AS MATERIALIZED (
  SELECT loan_id FROM library.copy_loan, input
  WHERE library.copy_loan.route=input.route AND library.copy_loan.account_id=input.account_id
  ORDER BY loan_id LIMIT 100
)
DELETE FROM library.copy_loan AS victim USING keys, input
WHERE victim.route=input.route AND victim.account_id=input.account_id AND victim.loan_id=keys.loan_id
RETURNING true AS removed;
