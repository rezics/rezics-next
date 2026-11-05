SELECT capture_id::text AS "captureId" FROM library.native_public_output_binding
WHERE route=$1 AND collection_id=$2 AND effect_key=$3;
