-- Rebuildable Realm directory topic keys. Concept identities stay in Main's
-- graph; this projection only supports bounded filtered paging.
ALTER TABLE access.realm_directory ADD COLUMN topics text[] NOT NULL DEFAULT '{}';
CREATE INDEX realm_directory_topics ON access.realm_directory USING gin (topics);
