-- migrate:up
ALTER TABLE content.media
  ADD COLUMN crop integer[],
  ADD COLUMN focal_x real,
  ADD COLUMN focal_y real;

ALTER TABLE content.media
  ADD CONSTRAINT media_crop_check CHECK (
    crop IS NULL OR (
      array_ndims(crop) = 1
      AND array_lower(crop, 1) = 1
      AND cardinality(crop) = 4
      AND array_position(crop, NULL::integer) IS NULL
      AND crop[1] >= 0
      AND crop[2] >= 0
      AND crop[3] >= 1
      AND crop[4] >= 1
    )
  ),
  ADD CONSTRAINT media_focal_point_check CHECK (
    (focal_x IS NULL AND focal_y IS NULL)
    OR (
      focal_x IS NOT NULL AND focal_y IS NOT NULL
      AND focal_x >= 0 AND focal_x <= 1
      AND focal_y >= 0 AND focal_y <= 1
    )
  );

-- migrate:down
DO $$ BEGIN
  RAISE EXCEPTION 'Published image crop and focal metadata is durable';
END $$;
