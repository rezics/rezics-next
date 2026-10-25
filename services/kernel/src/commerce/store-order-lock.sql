SELECT revision FROM commerce.purchase_order WHERE route = :route AND order_id = :id FOR UPDATE;
