-- Repeated deletion of the first remaining keyset advances without offsets.
-- Only keys enter the materialized page; payloads never enter work arguments/results.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id, :settled::jsonb AS settled
), settled AS MATERIALIZED (
  SELECT operation_id,ordinal FROM input,
    jsonb_to_recordset(input.settled) AS disposition(operation_id uuid,ordinal bigint)
), keys AS MATERIALIZED (
  SELECT target.operation_id,target.ordinal FROM library.bulk_target target
  JOIN library.bulk_operation operation ON operation.route=target.route
    AND operation.operation_id=target.operation_id AND operation.account_id=target.account_id
  CROSS JOIN input
  WHERE target.route=input.route AND target.account_id=input.account_id
    AND (
      NOT (
        (
          (operation.request->>'action'='add_to_collection' AND target.target_kind='subject') OR
          (operation.request->>'action'='remove_from_collection' AND target.target_kind='occurrence')
        ) AND (
          operation.request->>'collectionId' IS NULL OR
          target.target->>'collectionId' IS NULL OR
          operation.request->>'collectionId'<>target.target->>'collectionId' OR
          get_byte(uuid_send((operation.request->>'collectionId')::uuid),10)*256+
            get_byte(uuid_send((operation.request->>'collectionId')::uuid),11)<>input.route OR
          get_byte(uuid_send((target.target->>'collectionId')::uuid),10)*256+
            get_byte(uuid_send((target.target->>'collectionId')::uuid),11)<>input.route
        )
      ) OR EXISTS (
        SELECT 1 FROM settled
        WHERE settled.operation_id=target.operation_id AND settled.ordinal=target.ordinal
      )
    )
  ORDER BY target.operation_id,target.ordinal LIMIT 100
)
DELETE FROM library.bulk_target AS victim USING keys, input
WHERE victim.route=input.route AND victim.account_id=input.account_id
  AND victim.operation_id=keys.operation_id AND victim.ordinal=keys.ordinal
RETURNING true AS removed;
