-- migrate:up
-- Equality on the operator and purpose leaves reservation_id as the seek/order
-- key, including when the same account holds extensive membership history.
CREATE INDEX lifecycle_coordination_purpose_page
ON access.lifecycle_coordination (route, account_id, purpose, reservation_id);

-- migrate:down
DROP INDEX access.lifecycle_coordination_purpose_page;
