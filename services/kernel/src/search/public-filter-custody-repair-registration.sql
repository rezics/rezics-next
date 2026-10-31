SELECT consumer FROM search.public_filter_registration
WHERE (partition_no,id)=(:partition_no::integer,:registration::text) AND state='active' FOR SHARE;
