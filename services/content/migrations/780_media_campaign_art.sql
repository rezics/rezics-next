-- Campaign art uses the same inspected shape as Work showcase art, while
-- remaining immutable per slide rather than replacing a Realm selection.
ALTER TABLE media.use DROP CONSTRAINT use_role_check;
ALTER TABLE media.use ADD CONSTRAINT use_role_check CHECK (role IN ('avatar', 'publication-item', 'document-image',
  'showcase-background-landscape', 'showcase-background-portrait', 'showcase-cutout',
  'campaign-background-landscape', 'campaign-background-portrait', 'campaign-cutout')
  OR role ~ '^(showcase|campaign)-logo:[A-Za-z0-9-]{1,255}:(dark|light)$');

ALTER TABLE media.use DROP CONSTRAINT use_showcase_shape;
ALTER TABLE media.use ADD CONSTRAINT use_showcase_shape CHECK (
  (role !~ '^(showcase|campaign)-' AND focal_area IS NULL AND logo_anchor IS NULL
    AND oriented_width IS NULL AND oriented_height IS NULL AND has_alpha IS NULL)
  OR (role ~ '^(showcase|campaign)-' AND oriented_width BETWEEN 1 AND 16384 AND oriented_height BETWEEN 1 AND 16384
    AND oriented_width IS NOT NULL AND oriented_height IS NOT NULL AND has_alpha IS NOT NULL
    AND (focal_area IS NULL OR focal_area ~ '^xywh=percent:([0-9]{1,3}(\.[0-9]{1,3})?,){3}[0-9]{1,3}(\.[0-9]{1,3})?$')
    AND ((role ~ '^(showcase|campaign)-logo:' AND has_alpha AND logo_anchor IS NOT NULL
      AND logo_anchor IN ('start-bottom','center-top','center-middle','center-bottom'))
      OR (role IN ('showcase-cutout','campaign-cutout') AND has_alpha AND logo_anchor IS NULL)
      OR (role IN ('showcase-background-landscape','showcase-background-portrait',
        'campaign-background-landscape','campaign-background-portrait') AND logo_anchor IS NULL))));
