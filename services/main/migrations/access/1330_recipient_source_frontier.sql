-- Raw alias sources have independent principal seeks. The current source is
-- sufficient: completed sources are never retained in an audience-sized map.
ALTER TABLE access.notification_recipient_progress ADD COLUMN frontier jsonb;
UPDATE access.notification_recipient_progress SET frontier=jsonb_build_object(
  'source','base','afterPrincipal',after_principal::text,'legacyAfter',after_principal::text)
  WHERE after_principal IS NOT NULL AND NOT complete;

-- Participation is the durable author/reviewer source, including reviews made
-- after an earlier manual subscription. These identities bypass Ignore.
CREATE INDEX watch_participation_recipients ON access.watch_participation(target,principal_id);
INSERT INTO access.watch_participation(principal_id,target)
  SELECT DISTINCT r.principal,w.target FROM access.editorial_review r
  JOIN access.watch w ON w.principal_id=r.principal AND w.target='urn:rezics:proposal:'||r.proposal::text
  ON CONFLICT DO NOTHING;

-- An unfinished broadcast must survive long downtime. Cleanup only seeks the
-- completed positions, independently of the number of active broadcasts.
CREATE INDEX notification_completed_recipient_progress_retention
  ON access.notification_recipient_progress(updated_at) WHERE complete;
