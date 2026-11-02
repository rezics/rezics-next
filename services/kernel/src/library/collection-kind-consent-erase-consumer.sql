WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route,:account_id::uuid AS account_id,:after_id::nullable(text) AS after_id
), victims AS MATERIALIZED (
  SELECT consumer.route,consumer.reference_id
  FROM library.collection_kind_consent_consumer AS consumer,input
  WHERE consumer.route=input.route AND consumer.owner_account_id=input.account_id
    AND (input.after_id IS NULL OR consumer.reference_id>input.after_id)
  ORDER BY consumer.reference_id
  LIMIT 100
)
DELETE FROM library.collection_kind_consent_consumer AS consumer
USING victims
WHERE consumer.route=victims.route AND consumer.reference_id=victims.reference_id
RETURNING consumer.reference_id;
