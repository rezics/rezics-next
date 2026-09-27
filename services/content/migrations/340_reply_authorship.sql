-- One author and exact root per reply identity, fixed by its admitted first
-- draft. A second variant cannot squat on or replace an existing reply ID.
CREATE TABLE content.reply_author (
    reply text PRIMARY KEY,
    variant_id text NOT NULL UNIQUE REFERENCES content.variant(id),
    author text NOT NULL,
    root_target text NOT NULL,
    root_revision text NOT NULL,
    operation_id text NOT NULL UNIQUE REFERENCES content.receipt(operation_id)
);
CREATE TRIGGER reply_author_immutable BEFORE UPDATE OR DELETE ON content.reply_author
    FOR EACH ROW EXECUTE FUNCTION content.no_mutation();
CREATE INDEX reply_exact_root_page ON content.reply (root_target, root_revision, id);
