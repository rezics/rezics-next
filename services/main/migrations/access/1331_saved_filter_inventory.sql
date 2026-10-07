-- Named Saved Filters are not a stored quota. The principal write rate limit
-- bounds how fast they are added, and the list pages every one of them.
ALTER TABLE access.saved_filter_inventory DROP COLUMN named_count;
