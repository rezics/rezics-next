SELECT xmin::text AS xmin FROM library.native_public_output_binding WHERE partition_no=$1 AND capture_id=$2;
