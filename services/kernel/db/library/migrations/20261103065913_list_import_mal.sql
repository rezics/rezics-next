-- migrate:up
CREATE TABLE library.list_import_mal (
 route integer NOT NULL CHECK(route BETWEEN 0 AND 65535), account_id uuid NOT NULL, id uuid NOT NULL,
 document jsonb NOT NULL, expires_at timestamptz NOT NULL,
 PRIMARY KEY(route,account_id,id), CHECK(octet_length(document::text)<=12582912)
);
-- Private original upload, source fields, reviews and immutable command intents share one erasure owner.
CREATE INDEX list_import_mal_expiry ON library.list_import_mal(expires_at);
-- migrate:down
DROP TABLE library.list_import_mal;
