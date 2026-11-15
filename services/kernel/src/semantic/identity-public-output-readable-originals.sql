SELECT terminal::text,original::text
FROM semantic.identity_public_output_original
WHERE partition_no=$1 AND capture_id=$2
  AND (terminal,original)>($3::uuid,$4::uuid)
ORDER BY terminal,original LIMIT $5;
