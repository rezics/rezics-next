SELECT order_id AS "orderId", provider_object_id AS "objectId", context,
 provider_api_version AS "providerApiVersion", economics_hash AS "economicsHash"
FROM commerce.money_observation
WHERE route = :route AND buyer_account_id = :buyer
ORDER BY order_id, provider_object_id, context, provider_api_version, economics_hash LIMIT 100;
