CREATE TABLE access.realm_directory_position (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    data_epoch text, sequence bigint NOT NULL DEFAULT 0,
    target_sequence bigint, refresh_after text NOT NULL DEFAULT '',
    rebuilding boolean NOT NULL DEFAULT true
);
INSERT INTO access.realm_directory_position DEFAULT VALUES;
CREATE TABLE access.realm_directory (
    realm text PRIMARY KEY,
    space text NOT NULL,
    profile jsonb,
    created numeric(60) NOT NULL,
    activity numeric(60) NOT NULL,
    search_text text NOT NULL,
    count_kind text NOT NULL CHECK (count_kind IN ('unknown', 'estimated', 'exact')),
    count_value numeric(20) NOT NULL CHECK (count_value >= -1)
);
-- Match the keyset tuple and ORDER BY so LIMIT can stop the B-tree scan.
-- https://www.postgresql.org/docs/18/indexes-ordering.html
CREATE INDEX realm_directory_created ON access.realm_directory ((-created), realm);
CREATE INDEX realm_directory_activity ON access.realm_directory ((-activity), realm);
CREATE INDEX realm_directory_members ON access.realm_directory ((-count_value), realm);
CREATE FUNCTION access.refresh_realm_directory_count() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    UPDATE access.realm_directory SET count_value = NEW.value WHERE realm = NEW.realm AND count_kind = 'exact';
    RETURN NULL;
END $$;
CREATE TRIGGER realm_directory_count AFTER INSERT OR UPDATE ON access.realm_member_count
    FOR EACH ROW EXECUTE FUNCTION access.refresh_realm_directory_count();
