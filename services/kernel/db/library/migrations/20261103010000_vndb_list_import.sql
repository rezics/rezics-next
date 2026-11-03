-- migrate:up
CREATE TABLE library.vndb_import (
 route integer NOT NULL CHECK(route BETWEEN 0 AND 65535),
 account_id uuid NOT NULL, upload_id uuid NOT NULL,
 state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','cancelled')),
 expires_at timestamptz NOT NULL,
 xml text NOT NULL CHECK(octet_length(xml)<=2097152),
 rows jsonb NOT NULL CHECK(jsonb_typeof(rows)='array' AND jsonb_array_length(rows)<=5000 AND octet_length(rows::text)<=16777216),
 decisions jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(decisions)='object' AND octet_length(decisions::text)<=8388608),
 PRIMARY KEY(route,account_id,upload_id),
 CHECK(route=get_byte(uuid_send(account_id),10)*256+get_byte(uuid_send(account_id),11))
);
-- migrate:down
DROP TABLE library.vndb_import;
