WITH input AS NOT MATERIALIZED (SELECT :route::integer AS route, :collection_id::uuid AS collection_id),
requested AS MATERIALIZED (
  SELECT member_id, ordinal_key FROM jsonb_to_recordset(:items::jsonb) AS items(member_id uuid, ordinal_key text)
)
UPDATE library.collection_member member
SET ordinal_key=requested.ordinal_key, transaction_id=:transaction_id::uuid
FROM input, requested
WHERE member.route=input.route AND member.collection_id=input.collection_id
  AND (SELECT count(*) FROM requested) <= 128
  AND member.member_id=requested.member_id AND member.deletion_id IS NULL
RETURNING member.member_id AS id;
