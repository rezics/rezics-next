-- Probe each requested primary key before reading its bounded variant range.
WITH input AS NOT MATERIALIZED (
  SELECT :partition::integer AS partition
), requested AS MATERIALIZED (
  SELECT route, media_id
  FROM unnest(:routes::integer[], :media_ids::uuid[]) AS ids(route, media_id)
)
SELECT media.media_id AS "mediaId",
       CASE WHEN media.crop IS NULL THEN media.width ELSE media.crop[3] END AS width,
       CASE WHEN media.crop IS NULL THEN media.height ELSE media.crop[4] END AS height,
       encode(media.thumbhash, 'base64') AS thumbhash,
       media.average_color AS color,
       COALESCE(variants.variants_json, '[]') AS "variantsJson",
       media.focal_x AS "focalX", media.focal_y AS "focalY"
FROM requested CROSS JOIN input i
CROSS JOIN LATERAL (
  SELECT candidate.*
  FROM content.media AS candidate
  WHERE candidate.route = requested.route AND candidate.media_id = requested.media_id
    AND candidate.route >= i.partition * 16 AND candidate.route < (i.partition + 1) * 16
    AND candidate.purpose = 'avatar' AND candidate.state = 'available'
    AND NOT candidate.erased AND NOT candidate.collection_pending AND NOT candidate.taken_down
    AND candidate.actual_byte_count IS NOT NULL AND candidate.media_type IS NOT NULL
    AND candidate.sha256 IS NOT NULL
  LIMIT 1
) AS media
LEFT JOIN LATERAL (
  SELECT jsonb_agg(jsonb_build_object('format', variant.format, 'width', variant.width)
                   ORDER BY variant.width, variant.format)::text AS variants_json
  FROM content.media_variant AS variant
  WHERE variant.route = media.route AND variant.media_id = media.media_id
    AND variant.route >= i.partition * 16 AND variant.route < (i.partition + 1) * 16
) AS variants ON true;
