-- migrate:up
ALTER TABLE library.library_archive_merge_item
  DROP CONSTRAINT library_archive_merge_item_section_check,
  ADD CONSTRAINT library_archive_merge_item_section_check CHECK (section IN (
    'entries','labels','assignments','sessions','holdings','collections','collectionPins',
    'bangumiUploads','bangumiEvidence','malImports','units','history','occurrences','malEvidence',
    'annotations','journals'
  ));

-- migrate:down
ALTER TABLE library.library_archive_merge_item
  DROP CONSTRAINT library_archive_merge_item_section_check,
  ADD CONSTRAINT library_archive_merge_item_section_check CHECK (section IN (
    'entries','labels','assignments','sessions','holdings','collections','collectionPins',
    'bangumiUploads','bangumiEvidence','malImports','units','history','occurrences','malEvidence'
  ));
