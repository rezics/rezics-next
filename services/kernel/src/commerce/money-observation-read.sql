-- At most 258 named object/context anchors. Each index seek returns one recorded interpretation.
SELECT o.provider_object_id AS "objectId", o.context, o.money_unit::text AS unit,
 o.economics_hash AS "economicsHash", o.amounts::text AS amounts,
 o.provider_api_version AS "providerApiVersion", o.request_api_version AS "requestApiVersion",
 o.response_api_version AS "responseApiVersion", o.account_namespace AS "accountNamespace", o.livemode
FROM jsonb_to_recordset(:objects::jsonb) AS k(id text, context text)
CROSS JOIN LATERAL (
 SELECT * FROM commerce.money_observation m
 WHERE m.route = :route AND m.order_id = :order_id
 AND m.provider_object_id = k.id AND m.context = k.context AND m.money_unit IS NOT NULL
 ORDER BY m.recorded_at DESC, m.provider_api_version DESC, m.economics_hash DESC LIMIT 1
) o;
