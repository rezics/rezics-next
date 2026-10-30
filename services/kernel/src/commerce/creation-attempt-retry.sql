UPDATE commerce.checkout_creation_attempt SET retried = true
WHERE route = :route AND order_id = :id AND NOT retried;
