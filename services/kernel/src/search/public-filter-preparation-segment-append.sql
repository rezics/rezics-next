WITH input AS (
  SELECT $1::integer AS partition_no,$2::text AS registration,$3::text AS build,
    $4::numeric AS generation,$5::jsonb AS entries
)
INSERT INTO search.public_filter_preparation_segment
  (partition_no,registration,build,generation,raw_ordinal,output_ordinal,payload)
SELECT i.partition_no,i.registration,i.build,i.generation,
  e.raw_ordinal,e.output_ordinal,e.payload
FROM input i
CROSS JOIN LATERAL jsonb_to_recordset(i.entries) AS e(
  raw_ordinal integer,output_ordinal integer,payload jsonb
)
RETURNING raw_ordinal;
