INSERT INTO access.erasure_late_item (route, account_id, participant, locator)
VALUES (:route::integer, :account_id::uuid, :participant::text, :locator::text)
ON CONFLICT (route, account_id, participant, locator) DO NOTHING;
