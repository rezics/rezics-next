WITH input AS NOT MATERIALIZED (SELECT :route::integer AS route)
UPDATE library.collection_member member
SET collection_id=:destination_id::uuid, ordinal_key=:ordinal_key::text,
    member_revision=member_revision+1, transaction_id=:transaction_id::uuid
FROM input
WHERE member.route=input.route AND member.collection_id=:source_id::uuid
  AND member.member_id=:member_id::uuid AND member.deletion_id IS NULL
RETURNING member.member_id AS id;
