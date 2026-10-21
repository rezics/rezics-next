-- Extend the existing exact revision projection to native imported artwork.
-- v1 cover checks remain unchanged; VNDB v2 binds the actual immutable archive receipt.
CREATE OR REPLACE FUNCTION media.check_imported_cover_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM content.revision v
    JOIN media.asset a ON a.id = NEW.asset_id
    JOIN media.asset_state s ON s.id = a.state_head
    JOIN media.representation p ON p.id = NEW.original_representation_id AND p.asset_id = a.id
    JOIN media.upload u ON u.id = p.upload_id
    JOIN source.record r ON r.id = NEW.source_record_id
    JOIN source.observation o ON o.id = NEW.observation_id AND o.record_id = r.id
    WHERE v.id = NEW.asset_revision_id AND v.variant_id = a.variant_id
      AND v.model = 'media-asset-v1' AND v.availability = 'available'
      AND v.body->>'profile' = 'media-asset-v1'
      AND v.body->>'asset' = 'https://rezics.com/id/' || a.id::text
      AND v.body->>'coverOnly' = 'true'
      AND v.body->'importedCover' = u.imported_cover_intent
      AND (v.body->'representations') @> jsonb_build_array(jsonb_build_object(
        'id', p.id::text, 'role', 'original', 'sha256', p.byte_digest,
        'byteLength', p.byte_length, 'mediaType', p.media_type))
      AND a.cover_only AND s.lifecycle <> 'erased'
      AND p.kind = 'original' AND p.availability = 'available'
      AND p.byte_digest = NEW.original_digest
      AND u.declared_digest = p.byte_digest AND u.declared_byte_length = p.byte_length
      AND u.declared_media_type = p.media_type
      AND (u.imported_cover_intent->>'format' = 'media-imported-cover-v1'
        OR (u.imported_cover_intent->>'format' = 'media-imported-art-v2'
          AND u.imported_cover_intent->>'role' IN ('cover','portrait','screenshot')
          AND u.imported_cover_intent->>'targetWork' ~ '^https://rezics[.]com/id/[0-9a-f-]{36}$'
          AND ((r.provider <> 'vndb' AND u.imported_cover_intent->'archive' = 'null'::jsonb)
            OR (r.provider = 'vndb' AND EXISTS (
              SELECT 1 FROM source.archive_admission archive
              WHERE 'https://rezics.com/id/' || archive.id::text = u.imported_cover_intent->'archive'->>'admission'
                AND archive.record_id = r.id AND archive.observation_id = o.id
                AND archive.observation_digest = o.byte_digest AND archive.principal_id = u.principal_id
                AND u.imported_cover_intent->'archive'->'coordinate'->>'role' = u.imported_cover_intent->>'role'
                AND u.imported_cover_intent->'archive'->'coordinate'->>'rowDigest' = u.imported_cover_intent->'source'->>'recordDigest'
                AND u.imported_cover_intent->'archive'->'coordinate'->>'fieldLocator' = u.imported_cover_intent->'source'->>'fieldLocator'
                AND u.imported_cover_intent->'archive'->'coordinate'->>'table' = CASE u.imported_cover_intent->>'role'
                  WHEN 'cover' THEN 'vn' WHEN 'portrait' THEN 'chars' WHEN 'screenshot' THEN 'vn_screenshots' END
            )))))
      AND u.imported_cover_intent->'source'->>'record' = 'https://rezics.com/id/' || r.id::text
      AND u.imported_cover_intent->'source'->>'observation' = 'https://rezics.com/id/' || o.id::text
      AND u.imported_cover_intent->'source'->>'provider' = r.provider
      AND u.imported_cover_intent->'source'->>'namespace' = r.namespace
      AND u.imported_cover_intent->'source'->>'externalId' = r.external_id
      AND u.imported_cover_intent->'source'->>'sourceRevision' IS NOT DISTINCT FROM o.source_revision
      AND u.imported_cover_intent->'source'->>'observationDigest' = o.byte_digest
      AND u.imported_cover_intent->'source'->>'observationDigest' = NEW.observation_digest
      AND u.imported_cover_intent->'image'->>'captureDigest' = p.byte_digest
      AND u.imported_cover_intent->>'originalDigest' = p.byte_digest
      AND o.retention = 'retained' AND o.raw_bytes IS NOT NULL
      AND r.id = NEW.source_record_id AND o.record_id = NEW.source_record_id
      AND r.provider = NEW.provider AND r.namespace = NEW.namespace AND r.external_id = NEW.external_id
      AND u.imported_cover_intent->'source'->>'component' IS NOT DISTINCT FROM NEW.source_component
  ) THEN
    RAISE EXCEPTION 'imported cover projection does not match sealed owner evidence' USING ERRCODE = '23514',
      CONSTRAINT = 'imported_cover_revision_basis';
  END IF;
  RETURN NEW;
END $$;
