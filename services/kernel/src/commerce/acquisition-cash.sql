-- Retained native cash evidence wins over a current snapshot that claims no charge.
SELECT EXISTS (
  SELECT 1 FROM commerce.order_transaction WHERE route = :route::integer AND order_id = :order_id::uuid
) AS "hasCash";
