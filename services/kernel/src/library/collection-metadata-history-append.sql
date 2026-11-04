WITH state AS (
  INSERT INTO library.collection_metadata_history_state
    (route, collection_id, curator_account_id, coverage, known_from_revision, transaction_id, updated_at)
  VALUES
    (:route, :collection_id, :curator_account_id, 'unknown', :revision, :transaction_id, :recorded_at)
  ON CONFLICT (route, collection_id) DO UPDATE
    SET transaction_id = EXCLUDED.transaction_id, updated_at = EXCLUDED.updated_at
  RETURNING route, collection_id, curator_account_id
)
INSERT INTO library.collection_metadata_history
  (route, collection_id, curator_account_id, revision, transaction_id, recorded_at, changed_fields,
   before_title, after_title, before_description, after_description, before_visibility, after_visibility,
   before_presentation_kind, after_presentation_kind, before_cover_media_id, after_cover_media_id)
SELECT :route, :collection_id, :curator_account_id, :revision, :transaction_id, :recorded_at, :changed_fields,
       :before_title, :after_title, :before_description, :after_description, :before_visibility, :after_visibility,
       :before_presentation_kind, :after_presentation_kind, :before_cover_media_id, :after_cover_media_id
FROM state
WHERE state.route = :route AND state.collection_id = :collection_id
  AND state.curator_account_id = :curator_account_id
RETURNING revision;
