-- Called by the financial owner only after its account fence, in the same buyer-home command.
WITH input AS NOT MATERIALIZED (
 SELECT :route::integer AS route, :buyer::uuid AS buyer
), page AS (
 SELECT m.ctid FROM commerce.money_observation m, input
 WHERE m.route = input.route AND m.buyer_account_id = input.buyer
 ORDER BY m.order_id, m.provider_object_id, m.context, m.provider_api_version, m.economics_hash LIMIT 100
)
DELETE FROM commerce.money_observation m USING input
WHERE m.route = input.route AND m.ctid IN (SELECT ctid FROM page)
RETURNING m.order_id;
