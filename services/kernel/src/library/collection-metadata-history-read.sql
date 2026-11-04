SELECT revision, transaction_id AS "transactionId", recorded_at AS "recordedAt", changed_fields AS "changedFields",
       before_title AS "beforeTitle", after_title AS "afterTitle",
       before_description AS "beforeDescription", after_description AS "afterDescription",
       before_visibility AS "beforeVisibility", after_visibility AS "afterVisibility",
       before_presentation_kind AS "beforePresentationKind", after_presentation_kind AS "afterPresentationKind",
       before_cover_media_id AS "beforeCoverMediaId", after_cover_media_id AS "afterCoverMediaId"
FROM library.collection_metadata_history
WHERE route = :route AND collection_id = :collection_id AND curator_account_id = :curator_account_id
  AND revision = :revision;
