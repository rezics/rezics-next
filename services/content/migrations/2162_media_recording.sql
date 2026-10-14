ALTER TABLE media.asset DROP CONSTRAINT asset_media_kind_check;
ALTER TABLE media.asset ADD CONSTRAINT asset_media_kind_check CHECK (media_kind IN ('image','audio','video'));
ALTER TABLE media.upload DROP CONSTRAINT upload_declared_media_type_check;
ALTER TABLE media.upload ADD CONSTRAINT upload_declared_media_type_check CHECK (
  declared_media_type IN ('image/png','image/jpeg','image/webp','image/avif','image/gif','audio/wav','video/mp4'));
ALTER TABLE media.representation DROP CONSTRAINT representation_media_type_check;
ALTER TABLE media.representation ADD CONSTRAINT representation_media_type_check CHECK (
  media_type IN ('image/png','image/jpeg','image/webp','image/avif','image/gif','audio/wav','video/mp4'));
ALTER TABLE media.representation DROP CONSTRAINT representation_pixel_width_check;
ALTER TABLE media.representation DROP CONSTRAINT representation_pixel_height_check;
ALTER TABLE media.representation ADD CONSTRAINT representation_dimensions_check CHECK (
  (media_type='audio/wav' AND pixel_width=0 AND pixel_height=0)
  OR (media_type<>'audio/wav' AND pixel_width BETWEEN 1 AND 16384 AND pixel_height BETWEEN 1 AND 16384));
ALTER TABLE media.representation ADD COLUMN duration_seconds double precision CHECK (
  duration_seconds > 0 AND duration_seconds <= 86400 AND duration_seconds <> 'Infinity'::float8);
CREATE FUNCTION media.recording_duration_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.duration_seconds IS DISTINCT FROM OLD.duration_seconds THEN RAISE EXCEPTION 'recording duration is immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER recording_duration_immutable BEFORE UPDATE ON media.representation
  FOR EACH ROW EXECUTE FUNCTION media.recording_duration_immutable();
