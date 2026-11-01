UPDATE semantic.identity_scope_summary SET active=active+$4,state='repair',revision=revision+1
WHERE partition_no=$1 AND source_key=$2 AND scope_id=$3;
