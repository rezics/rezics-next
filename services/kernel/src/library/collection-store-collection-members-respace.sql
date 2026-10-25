WITH input AS (SELECT :transaction_id::uuid AS transaction_id), requested AS MATERIALIZED (
  SELECT member_id, ordinal_key
  FROM jsonb_to_recordset(:items::jsonb) AS requested(member_id uuid, ordinal_key text)
), parent AS (
  UPDATE library.collection AS collection
  SET order_epoch = order_epoch + 1, updated_at = :time, transaction_id = input.transaction_id
  FROM input
  WHERE route = :route AND collection_id = :collection_id
    AND member_count = (SELECT count(*) FROM requested)
    AND (SELECT count(DISTINCT member_id) FROM requested) = (SELECT count(*) FROM requested)
    AND (SELECT count(*) FROM requested
         JOIN library.collection_member USING (member_id)
         WHERE collection_member.route = collection.route AND collection_member.collection_id = collection.collection_id)
        = (SELECT count(*) FROM requested)
  RETURNING route, collection_id, order_epoch
), updated AS (
  UPDATE library.collection_member AS member
  SET ordinal_key = requested.ordinal_key, transaction_id = input.transaction_id
  FROM requested, parent, input
  WHERE member.route = parent.route AND member.collection_id = parent.collection_id AND member.member_id = requested.member_id
  RETURNING member.member_id
)
SELECT parent.order_epoch AS "orderEpoch", (SELECT count(*)::integer FROM updated) AS "membersUpdated"
FROM parent;
