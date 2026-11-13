SELECT raw_ordinal,output_ordinal,payload
FROM search.public_filter_preparation_segment
WHERE (partition_no,registration,build,generation)=($1,$2,$3,$4::numeric)
  AND raw_ordinal >= $5 AND raw_ordinal < $6
ORDER BY raw_ordinal;
