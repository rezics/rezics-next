WITH input AS MATERIALIZED (
  SELECT $1::integer AS partition_no,$2::text AS registration,$3::text AS build,$4::numeric AS generation,
    $5::integer AS first_output_ordinal,$6::integer AS window_size
), prepared AS MATERIALIZED (
  SELECT p.partition_no,p.registration,p.build,p.generation,p.segment_state,p.raw_count,p.output_count,p.raw_exhausted
  FROM search.public_filter_prepared p JOIN input i
    ON (p.partition_no,p.registration,p.build,p.generation)=
       (i.partition_no,i.registration,i.build,i.generation)
), output_window AS (
  SELECT s.raw_ordinal,s.output_ordinal,s.payload
  FROM search.public_filter_preparation_segment s JOIN input i
    ON (s.partition_no,s.registration,s.build,s.generation)=
       (i.partition_no,i.registration,i.build,i.generation)
  WHERE s.output_ordinal >= i.first_output_ordinal
  ORDER BY s.output_ordinal
  LIMIT (SELECT window_size FROM input)
)
SELECT p.segment_state,p.raw_count,p.output_count,p.raw_exhausted,
  w.raw_ordinal,w.output_ordinal,w.payload
FROM prepared p LEFT JOIN output_window w ON true
ORDER BY w.output_ordinal NULLS FIRST;
