-- Publication mandates name one Work; assignment ceilings may span Works.
ALTER TABLE access.principal_permission_grant ADD CONSTRAINT work_publication_exact_scope
  CHECK (action <> 'platform:resource:work.publish' OR
    scope_id ~ '^work:publish:https://rezics[.]com/id/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');
ALTER TABLE access.group_permission_grant ADD CONSTRAINT work_publication_exact_scope
  CHECK (action <> 'platform:resource:work.publish' OR
    scope_id ~ '^work:publish:https://rezics[.]com/id/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');

-- The immutable first designation alone receives assignment, never publication.
CREATE FUNCTION access.seed_source_publication_assignment_ceiling(principal uuid, designation text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE actor text; first_holder uuid; first_receipt text; holder_active boolean;
BEGIN
  SELECT g.principal_id,e.receipt,
    (g.active AND g.valid_until = 'infinity' AND p.active)
    INTO first_holder,first_receipt,holder_active
  FROM access.platform_grant_episode e
  JOIN access.principal_permission_grant g ON g.id = e.principal_grant_id
  JOIN access.principal p ON p.id = g.principal_id
  WHERE e.permission = 'platform:grant' AND e.principal_grant_id IS NOT NULL
  ORDER BY e.created_at,e.id LIMIT 1 FOR UPDATE OF g;
  IF first_holder IS DISTINCT FROM principal OR first_receipt IS DISTINCT FROM designation
    OR NOT holder_active THEN RETURN; END IF;
  SELECT r.subject_id INTO actor FROM access.representation r
  JOIN access.authority_subject s ON s.id = r.subject_id AND s.kind = 'agent' AND s.active
  WHERE r.principal_id = principal AND r.action = 'agent.control' AND r.active
    AND r.valid_until > clock_timestamp() ORDER BY r.id LIMIT 1;
  IF actor IS NULL THEN RETURN; END IF;
  INSERT INTO access.scope_gate(id) VALUES ('work:publish:*') ON CONFLICT DO NOTHING;
  -- Remember terminal ceilings by principal too: controller replacement and
  -- repeat startup cannot restore an intentionally revoked assignment.
  INSERT INTO access.permission_grant(id,issuer_subject,recipient_subject,scope_id,action,
    valid_until,assigned_by_principal)
  SELECT gen_random_uuid(),actor,actor,'work:publish:*',
    'access.grant.assign.work.publish','infinity',principal
  WHERE NOT EXISTS (SELECT 1 FROM access.permission_grant
    WHERE scope_id = 'work:publish:*' AND action = 'access.grant.assign.work.publish'
      AND (assigned_by_principal = principal OR recipient_subject = actor));
END $$;

ALTER FUNCTION access.seed_platform_grants(uuid,text) RENAME TO seed_platform_pre_publication_grants;
CREATE FUNCTION access.seed_platform_grants(principal uuid, designation text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM access.seed_platform_pre_publication_grants(principal,designation);
  PERFORM access.seed_source_publication_assignment_ceiling(principal,designation);
END $$;

-- Backfill only the original deployment designation, with the same live checks.
SELECT access.seed_source_publication_assignment_ceiling(g.principal_id,e.receipt)
FROM access.platform_grant_episode e
JOIN access.principal_permission_grant g ON g.id = e.principal_grant_id
WHERE e.permission = 'platform:grant' AND e.principal_grant_id IS NOT NULL
ORDER BY e.created_at,e.id LIMIT 1;
