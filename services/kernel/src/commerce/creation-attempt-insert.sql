INSERT INTO commerce.checkout_creation_attempt
    (route, order_id, first_attempt_id, first_attempt_at, provider_key, success_url, cancel_url,
     expires_at, managed_payments)
VALUES (:route, :id, :attempt_id, :at, :provider_key, :success_url, :cancel_url, :expires_at, :managed_payments);
