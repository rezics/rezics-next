-- migrate:up
-- One bounded consent per retained upload; the source coordinator owns physical cleanup.
CREATE TABLE library.vndb_label_adoption (
 route integer NOT NULL,
 account_id uuid NOT NULL,
 upload_id uuid NOT NULL,
 preview_id uuid NOT NULL,
 state text NOT NULL CHECK(state IN ('reviewed','applying','cancelled')),
 expires_at timestamptz NOT NULL,
 mappings jsonb NOT NULL CHECK(jsonb_typeof(mappings)='array' AND jsonb_array_length(mappings) BETWEEN 1 AND 8 AND octet_length(mappings::text)<=16384),
 item_count integer NOT NULL CHECK(item_count BETWEEN 1 AND 64),
 PRIMARY KEY(route,account_id,upload_id),
 FOREIGN KEY(route,account_id,upload_id) REFERENCES library.vndb_import(route,account_id,upload_id) ON DELETE CASCADE
);
CREATE TABLE library.vndb_label_adoption_item (
 route integer NOT NULL,
 account_id uuid NOT NULL,
 upload_id uuid NOT NULL,
 item_no integer NOT NULL CHECK(item_no BETWEEN 0 AND 63),
 operand jsonb NOT NULL CHECK(octet_length(operand::text)<=4096),
 status text NOT NULL CHECK(status IN ('ready','applied','already_present','stale','unsupported','refused')),
 result jsonb CHECK(result IS NULL OR octet_length(result::text)<=1024),
 PRIMARY KEY(route,account_id,upload_id,item_no),
 FOREIGN KEY(route,account_id,upload_id) REFERENCES library.vndb_label_adoption(route,account_id,upload_id) ON DELETE CASCADE
);
-- Source expiry uses its bounded owner prefix (at most four uploads); cascade visits at most 256 items.
-- migrate:down
DROP TABLE library.vndb_label_adoption_item;
DROP TABLE library.vndb_label_adoption;
