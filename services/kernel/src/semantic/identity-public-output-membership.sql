SELECT terminal::text FROM semantic.identity_public_output_member
WHERE partition_no=$1 AND capture_id=$2 AND terminal=ANY($3::uuid[]) ORDER BY terminal;
