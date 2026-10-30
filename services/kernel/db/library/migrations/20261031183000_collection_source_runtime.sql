-- migrate:up
-- Ordinal preparation consumes raw occurrences, including retained deletion episodes.
CREATE INDEX collection_member_raw_ordinal
  ON library.collection_member(route,collection_id,ordinal_key,member_id);

-- migrate:down
DROP INDEX library.collection_member_raw_ordinal;
