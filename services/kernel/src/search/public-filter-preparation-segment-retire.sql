WITH candidate AS MATERIALIZED (
  SELECT partition_no,registration,build,generation,raw_ordinal
  FROM search.public_filter_preparation_segment
  WHERE (partition_no,registration,build,generation)=($1,$2,$3,$4::numeric)
  ORDER BY raw_ordinal
  LIMIT $5
)
DELETE FROM search.public_filter_preparation_segment s USING candidate c
WHERE (s.partition_no,s.registration,s.build,s.generation,s.raw_ordinal)=
      (c.partition_no,c.registration,c.build,c.generation,c.raw_ordinal)
RETURNING s.raw_ordinal;
