SELECT body FROM semantic.identity_public_output_page
WHERE partition_no=$1 AND capture_id=$2 AND version>$3 ORDER BY version LIMIT 1;
