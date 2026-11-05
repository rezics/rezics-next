INSERT INTO search.identity_receiving_native_copy(partition_no,plan_id,copy_no,locator,transaction_id)
SELECT $1,$2,(ordinality-1+$4)::integer,value,$5
FROM jsonb_array_elements($3::jsonb) WITH ORDINALITY;
