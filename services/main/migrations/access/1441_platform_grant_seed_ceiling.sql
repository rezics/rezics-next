-- The designation ceiling is the same consequence as an API platform:grant.
-- Link the seeded access.grant.assign.platform row to that grant. Stacks that
-- already ran 1290 and 1440 get the link here; later seed calls repeat it safely.
CREATE FUNCTION access.link_seeded_platform_assignment_ceiling(subject_principal uuid)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE seeded_grant uuid; episode_principal uuid; grant_issuer text;
  grant_until timestamptz; grant_active boolean; seeded_ceiling uuid; ceiling_principal uuid;
BEGIN
  SELECT g.id, e.assigned_by_principal, g.issuer_subject, g.valid_until, g.active
    INTO seeded_grant, episode_principal, grant_issuer, grant_until, grant_active
  FROM access.principal_permission_grant g
  JOIN access.platform_grant_episode e ON e.principal_grant_id = g.id
  WHERE g.principal_id = subject_principal AND g.action = 'platform:grant'
    AND e.permission = 'platform:grant'
  ORDER BY e.created_at, e.id
  LIMIT 1
  FOR UPDATE OF g;
  IF seeded_grant IS NULL
    OR EXISTS (SELECT 1 FROM access.platform_assignment_ceiling WHERE grant_id = seeded_grant) THEN
    RETURN;
  END IF;
  -- The seeded ceiling sits on the grant's own issuer. A later agent, or a
  -- ceiling already bound to another grant, is not this designation.
  SELECT c.id, c.assigned_by_principal INTO seeded_ceiling, ceiling_principal
  FROM access.permission_grant c
  WHERE c.recipient_subject = grant_issuer AND c.issuer_subject = grant_issuer
    AND c.scope_id = 'platform:access' AND c.action = 'access.grant.assign.platform'
    AND c.valid_until = grant_until
    AND NOT EXISTS (SELECT 1 FROM access.platform_assignment_ceiling l WHERE l.ceiling_id = c.id)
    AND EXISTS (
      SELECT 1 FROM access.representation r
      WHERE r.principal_id = subject_principal AND r.subject_id = c.recipient_subject
        AND r.action = 'agent.control')
  ORDER BY c.id
  LIMIT 1
  FOR UPDATE OF c;
  IF seeded_ceiling IS NULL OR (ceiling_principal IS NOT NULL
    AND ceiling_principal IS DISTINCT FROM episode_principal) THEN
    RETURN;
  END IF;
  UPDATE access.permission_grant SET assigned_by_principal = episode_principal
  WHERE id = seeded_ceiling AND assigned_by_principal IS NULL;
  INSERT INTO access.platform_assignment_ceiling(grant_id, ceiling_id)
  VALUES (seeded_grant, seeded_ceiling);
  IF NOT grant_active THEN
    UPDATE access.permission_grant SET active = false WHERE id = seeded_ceiling AND active;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION access.seed_platform_grants(principal uuid, designation text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE actor text; item record; grant_id uuid;
BEGIN
  SELECT r.subject_id INTO actor FROM access.representation r JOIN access.authority_subject s ON s.id = r.subject_id
    WHERE r.principal_id = principal AND r.action = 'agent.control' AND r.active
      AND r.valid_until > clock_timestamp() AND s.active ORDER BY r.id LIMIT 1;
  IF actor IS NULL THEN
    SELECT agent_id INTO actor FROM access.agent_provision WHERE principal_id = principal AND state = 'active' ORDER BY agent_id LIMIT 1;
  END IF;
  IF actor IS NULL THEN
    actor := 'https://rezics.com/id/00000000-0000-4000-8000-000000000129';
    INSERT INTO access.authority_subject(id,kind) VALUES (actor,'institution') ON CONFLICT DO NOTHING;
  END IF;
  FOR item IN SELECT * FROM (VALUES
    ('platform:grant','platform:access'), ('platform:use:platform-admin','platform:access'),
    ('platform:resource:rating.context.create','rating:context:target:https://rezics.com/id/00000000-0000-8000-8000-676c6f62616c'),
    ('platform:resource:work.create','work:create:root'),
    ('platform:resource:space.create','space:create:root'),
    ('platform:resource:semantic.change','semantic:create:root'),
    ('platform:resource:catalogue.verify','catalogue:verify:root'),
    ('platform:resource:classification.proposition.define','classification:define:global'),
    ('platform:resource:media.labels.protect','media:protect:*'),
    ('platform:resource:media.conceal.protect','media:protect:*'),
    ('platform:resource:zone.edit','zone:edit:*'),
    ('platform:resource:media.campaign','zone:edit:*'),
    ('platform:resource:zone.official','zone:official:*'),
    ('platform:resource:semantic.read','semantic:read:*'),
    ('platform:resource:semantic.change','semantic:edit:*'),
    ('platform:resource:lexicon.presentation.change','semantic:edit:*'),
    ('platform:resource:lexicon.presentation.review','semantic:edit:*'),
    ('platform:resource:rating.question-presentation.change','rating:presentation:*'),
    ('platform:resource:rating.question-presentation.review','rating:presentation:*'),
    ('platform:resource:governance.moderate','governance:platform'),
    ('platform:resource:governance.rights.decide','governance:platform'),
    ('platform:resource:governance.safety.evidence','governance:platform'),
    ('platform:resource:governance.appeal','governance:platform')
  ) AS permissions(action,scope) LOOP
    INSERT INTO access.scope_gate(id) VALUES (item.scope) ON CONFLICT DO NOTHING;
    IF NOT EXISTS (SELECT 1 FROM access.principal_permission_grant WHERE principal_id = principal
      AND action = item.action AND scope_id = item.scope) THEN
      grant_id := gen_random_uuid();
      INSERT INTO access.principal_permission_grant(id,issuer_subject,principal_id,scope_id,action,valid_until)
        VALUES (grant_id,actor,principal,item.scope,item.action,'infinity');
      INSERT INTO access.platform_grant_episode(id,principal_grant_id,issuer_subject,permission,scope_id,assigned_by_principal,receipt)
        VALUES (grant_id,grant_id,actor,item.action,item.scope,principal,designation);
    END IF;
    IF item.action LIKE 'platform:resource:%' THEN
      INSERT INTO access.permission_grant(id,issuer_subject,recipient_subject,scope_id,action,valid_until)
        SELECT gen_random_uuid(),actor,actor,item.scope,'access.grant.assign.' || substring(item.action FROM 19),'infinity'
        WHERE NOT EXISTS (SELECT 1 FROM access.permission_grant WHERE recipient_subject = actor
          AND scope_id = item.scope AND action = 'access.grant.assign.' || substring(item.action FROM 19));
    END IF;
  END LOOP;
  INSERT INTO access.permission_grant(id,issuer_subject,recipient_subject,scope_id,action,valid_until,assigned_by_principal)
    SELECT gen_random_uuid(),actor,actor,'platform:access','access.grant.assign.platform','infinity',principal
    WHERE NOT EXISTS (SELECT 1 FROM access.permission_grant WHERE recipient_subject = actor
      AND scope_id = 'platform:access' AND action = 'access.grant.assign.platform');
  PERFORM access.link_seeded_platform_assignment_ceiling(principal);
END $$;

SELECT access.link_seeded_platform_assignment_ceiling(principal_id)
FROM (
  SELECT DISTINCT principal_id FROM access.principal_permission_grant WHERE action = 'platform:grant'
) holders;
