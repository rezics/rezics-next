-- migrate:up
-- A revision row is rewritten once, when its post is erased: body, digest and search text become NULL and no
-- indexed column changes. Reserving half of each new heap page lets that rewrite stay on the page (a HOT update), so
-- erasing a page of revisions writes no index entries and reads blocks in proportion to its own rows however full
-- the neighbouring pages and indexes are. The setting applies to pages written from now on.
ALTER TABLE content.revision SET (fillfactor = 50);

-- migrate:down
ALTER TABLE content.revision RESET (fillfactor);
