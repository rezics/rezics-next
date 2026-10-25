-- migrate:up
CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;

-- migrate:down
