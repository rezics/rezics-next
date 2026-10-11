-- Canonical activation belongs to the same owner transition that records the
-- posted receipt. No second client round-trip reveals whether it was an opener.
CREATE FUNCTION content.activate_posted_about_thread() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    UPDATE content.realm_about_thread SET state='active',revision_id=NEW.revision_id
        WHERE realm=NEW.realm AND about=NEW.about;
    RETURN NEW;
END $$;
CREATE TRIGGER realm_about_posted_thread AFTER UPDATE OF phase ON content.realm_about_post_operation
    FOR EACH ROW WHEN (OLD.phase <> 'posted' AND NEW.phase='posted' AND NEW.reply=NEW.opener_reply)
    EXECUTE FUNCTION content.activate_posted_about_thread();
