-- Author pages (G-382) find an author's Works and count their readers.
-- Adopted Works whose retained conversion reports an Open Library author:
-- `projection -> 'authorRefs' @> '[{"sourceKey": "/authors/OL1A"}]'`.
CREATE INDEX conversion_author_refs_idx ON source.conversion
  USING gin ((projection -> 'authorRefs') jsonb_path_ops);
-- Distinct people reading or finished with any of an author's Works.
CREATE INDEX library_status_readers_idx ON reader.library_status (work, agent)
  WHERE status IN ('reading', 'read');
