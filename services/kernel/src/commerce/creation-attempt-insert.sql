INSERT INTO commerce.checkout_creation_attempt
    (route, order_id, first_attempt_id, first_attempt_at, provider_key, success_url, cancel_url,
     expires_at, managed_payments, request, money_unit, tax_behavior, api_version)
VALUES (:route, :id, :attempt_id, :at, :provider_key, :success_url, :cancel_url, :expires_at, :managed_payments, :request::text::jsonb, :money_unit::text::jsonb, :tax_behavior, :api_version);
