-- Extend the existing selection identity and CAS guards; avatar keys and all
-- previously admitted Use roles keep their meaning.
ALTER TABLE media.use DROP CONSTRAINT use_role_check;
ALTER TABLE media.use ADD CONSTRAINT use_role_check CHECK (role IN ('avatar', 'publication-item', 'document-image',
  'showcase-background-landscape', 'showcase-background-portrait', 'showcase-cutout')
  OR role ~ '^showcase-logo:[A-Za-z0-9-]{1,255}:(dark|light)$');
ALTER TABLE media.selection_slot DROP CONSTRAINT selection_slot_role_check;
ALTER TABLE media.selection_slot DROP CONSTRAINT selection_slot_policy_check;
ALTER TABLE media.selection_slot ADD CONSTRAINT selection_slot_role_check CHECK (role IN ('avatar',
  'showcase-background-landscape', 'showcase-background-portrait', 'showcase-cutout', 'showcase-trailer')
  OR role ~ '^showcase-logo:[A-Za-z0-9-]{1,255}:(dark|light)$');
ALTER TABLE media.selection_slot ADD CONSTRAINT selection_slot_policy_check CHECK (
  (role = 'avatar' AND policy = 'avatar-selection-v1')
  OR (role LIKE 'showcase-%' AND policy = 'showcase-selection-v1'));

ALTER TABLE media.use ADD COLUMN focal_area text,
  ADD COLUMN logo_anchor text,
  ADD COLUMN oriented_width integer,
  ADD COLUMN oriented_height integer,
  ADD COLUMN has_alpha boolean;
ALTER TABLE media.use ADD CONSTRAINT use_showcase_shape CHECK (
  (role NOT LIKE 'showcase-%' AND focal_area IS NULL AND logo_anchor IS NULL
    AND oriented_width IS NULL AND oriented_height IS NULL AND has_alpha IS NULL)
  OR (role LIKE 'showcase-%' AND oriented_width BETWEEN 1 AND 16384 AND oriented_height BETWEEN 1 AND 16384
    AND oriented_width IS NOT NULL AND oriented_height IS NOT NULL AND has_alpha IS NOT NULL
    AND (focal_area IS NULL OR focal_area ~ '^xywh=percent:([0-9]{1,3}(\.[0-9]{1,3})?,){3}[0-9]{1,3}(\.[0-9]{1,3})?$')
    AND ((role LIKE 'showcase-logo:%' AND has_alpha AND logo_anchor IS NOT NULL
      AND logo_anchor IN ('start-bottom','center-top','center-middle','center-bottom'))
      OR (role = 'showcase-cutout' AND has_alpha AND logo_anchor IS NULL)
      OR (role IN ('showcase-background-landscape','showcase-background-portrait') AND logo_anchor IS NULL))));
ALTER TABLE media.selection_revision ADD COLUMN trailer_url text;
ALTER TABLE media.selection_revision ADD CONSTRAINT selection_trailer_shape CHECK (
  (role = 'showcase-trailer' AND use_id IS NULL
    AND (trailer_url IS NULL OR (length(trailer_url) <= 2048 AND trailer_url ~ '^https://')))
  OR (role <> 'showcase-trailer' AND trailer_url IS NULL));

-- The existing target/context/role PK remains the read and write index. Query
-- only this bounded target set's showcase slots, never its selection history.
CREATE INDEX selection_showcase_target_idx ON media.selection_slot (target, context, role)
  WHERE role LIKE 'showcase-%';
