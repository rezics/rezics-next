WITH input AS NOT MATERIALIZED (
  SELECT :state::text AS state, :decision::nullable(text) AS decision, :transaction_id::uuid AS transaction_id,
         :route::integer AS route, :media_id::uuid AS media_id,
         :width::nullable(integer) AS width, :height::nullable(integer) AS height,
         :thumbhash::nullable(bytea) AS thumbhash, :average_color::nullable(text) AS average_color,
         :crop::nullable(integer[]) AS crop, :focal_x::nullable(real) AS focal_x,
         :focal_y::nullable(real) AS focal_y
), changed AS (
  UPDATE content.media AS m
  SET state = input.state, decision = input.decision,
      collection_pending = (input.state = 'rejected'), transaction_id = input.transaction_id,
      width = input.width, height = input.height, thumbhash = input.thumbhash,
      average_color = input.average_color, crop = input.crop,
      focal_x = input.focal_x, focal_y = input.focal_y
  FROM input
  WHERE m.route = input.route AND m.media_id = input.media_id
    AND m.state = 'uploaded' AND NOT m.erased AND NOT m.collection_pending
  RETURNING m.route, m.media_id, m.state, m.transaction_id
), variants AS (
  INSERT INTO content.media_variant
    (route, media_id, format, width, height, media_type, byte_count, sha256, key, transaction_id)
  SELECT input.route, changed.media_id, variant.format, variant.width, variant.height,
         variant."mediaType", variant."byteCount", variant.sha256, variant.key, changed.transaction_id
  FROM changed CROSS JOIN input
  CROSS JOIN jsonb_to_recordset(:variants::jsonb) AS variant(
    format text, width integer, height integer, "mediaType" text, "byteCount" bigint, sha256 text, key text
  )
  WHERE changed.state = 'available'
  RETURNING media_id
)
SELECT media_id FROM changed;
