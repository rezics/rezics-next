-- Intent selections describe historical owner decisions. A foreign key to the
-- current canonical selection incorrectly prevents terminally rejected openers
-- from releasing their reservation while retaining those immutable intents.
ALTER TABLE content.realm_about_post_operation
    DROP CONSTRAINT realm_about_post_operation_realm_about_opener_reply_fkey;

CREATE OR REPLACE FUNCTION content.guard_realm_about_thread() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.state = 'active' THEN
            RAISE EXCEPTION 'activated canonical discussion keys are retained' USING ERRCODE = '23514';
        END IF;
        RETURN OLD;
    END IF;
    IF TG_OP = 'UPDATE' AND (
        (NEW.realm, NEW.about, NEW.opener_reply, NEW.root_revision, NEW.created_at)
            IS DISTINCT FROM (OLD.realm, OLD.about, OLD.opener_reply, OLD.root_revision, OLD.created_at)
        OR OLD.state = 'active' AND NEW IS DISTINCT FROM OLD
    ) THEN RAISE EXCEPTION 'canonical discussion selection is immutable' USING ERRCODE = '23514'; END IF;
    IF NEW.state = 'active' AND NOT EXISTS (
        SELECT 1 FROM content.realm_about_post_operation o
        WHERE o.reply = NEW.opener_reply AND o.phase = 'posted' AND o.revision_id = NEW.revision_id
    ) THEN RAISE EXCEPTION 'canonical opener must be posted' USING ERRCODE = '23514'; END IF;
    RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION content.activate_posted_about_thread() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    UPDATE content.realm_about_thread SET state='active',revision_id=NEW.revision_id
        WHERE realm=NEW.realm AND about=NEW.about AND opener_reply=NEW.reply;
    RETURN NEW;
END $$;
