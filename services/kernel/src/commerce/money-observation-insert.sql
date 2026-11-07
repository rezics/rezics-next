WITH input AS NOT MATERIALIZED (
 SELECT :route::integer AS route, :order_id::uuid AS order_id, :buyer::uuid AS buyer
)
INSERT INTO commerce.money_observation AS retained
(route, order_id, buyer_account_id, provider_object_id, context, account_namespace, livemode,
 provider_api_version, request_api_version, response_api_version, money_unit, economics_hash,
 amounts, observed_at, recorded_at, transaction_id)
SELECT i.route, i.order_id, i.buyer, o.object_id, o.context, o.namespace, o.livemode,
 o.api_version, o.request_version, o.response_version, o.unit, o.economics_hash,
 o.amounts, :observed_at, :at, :transaction_id
FROM input i CROSS JOIN jsonb_to_recordset(:observations::jsonb) AS o(object_id text, context text, namespace text,
 livemode boolean, api_version text, request_version text, response_version text, unit jsonb,
 economics_hash text, amounts jsonb)
JOIN access.account a ON a.route=i.route AND a.account_id=i.buyer AND a.state='active'
WHERE NOT EXISTS (SELECT 1 FROM access.erasure e WHERE e.route=i.route AND e.account_id=i.buyer)
ON CONFLICT DO NOTHING
RETURNING provider_object_id AS "objectId", context;
