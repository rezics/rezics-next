SELECT document_id FROM search.identity_receiving_native_document
WHERE partition_no=$1 AND physical_target=$2 AND document_id=$3 FOR UPDATE;
