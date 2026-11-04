WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :collection_id::uuid AS collection_id,
         :curator_account_id::uuid AS curator_account_id, :revision::integer AS revision,
         :transaction_id::uuid AS transaction_id, :recorded_at::timestamptz AS recorded_at,
         :changed_fields::text[] AS changed_fields,
         :before_title::text AS before_title, :after_title::text AS after_title,
         :before_description::text AS before_description, :after_description::text AS after_description,
         :before_visibility::text AS before_visibility, :after_visibility::text AS after_visibility,
         :before_presentation_kind::text AS before_presentation_kind,
         :after_presentation_kind::text AS after_presentation_kind,
         :before_cover_media_id::uuid AS before_cover_media_id, :after_cover_media_id::uuid AS after_cover_media_id
), state AS (
  INSERT INTO library.collection_metadata_history_state
    (route, collection_id, curator_account_id, coverage, known_from_revision, transaction_id, updated_at)
  SELECT route, collection_id, curator_account_id, 'unknown', revision, transaction_id, recorded_at
  FROM input
  ON CONFLICT (route, collection_id) DO UPDATE
    SET transaction_id = EXCLUDED.transaction_id, updated_at = EXCLUDED.updated_at
  RETURNING route, collection_id, curator_account_id
)
INSERT INTO library.collection_metadata_history
  (route, collection_id, curator_account_id, revision, transaction_id, recorded_at, changed_fields,
   before_title, after_title, before_description, after_description, before_visibility, after_visibility,
   before_presentation_kind, after_presentation_kind, before_cover_media_id, after_cover_media_id)
SELECT input.route, input.collection_id, input.curator_account_id, input.revision, input.transaction_id,
       input.recorded_at, input.changed_fields, input.before_title, input.after_title,
       input.before_description, input.after_description, input.before_visibility, input.after_visibility,
       input.before_presentation_kind, input.after_presentation_kind, input.before_cover_media_id,
       input.after_cover_media_id
FROM input JOIN state USING (route, collection_id, curator_account_id)
RETURNING revision;
