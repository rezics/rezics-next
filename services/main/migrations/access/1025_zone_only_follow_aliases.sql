-- A Zone capability need not share its Space with a Realm. Keep existing
-- canonical aliases and membership triggers; absence is not a fabricated Realm.
ALTER TABLE access.follow_space_alias ALTER COLUMN realm DROP NOT NULL;
