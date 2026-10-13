-- Only the original deployment designation may assign platform rule publishers.
-- Publication itself still requires an explicit Access resource grant.
CREATE FUNCTION access.seed_rule_publisher_assignment_ceiling(principal uuid, designation text)
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
  INSERT INTO access.scope_gate(id) VALUES ('governance:platform') ON CONFLICT DO NOTHING;
  -- Terminal ceilings, including expired or revoked ones, are not bootstrap work.
  -- Remember the principal as well as its controller so changing controllers
  -- cannot turn repeat bootstrap into a second assignment after revocation.
  INSERT INTO access.permission_grant(id,issuer_subject,recipient_subject,scope_id,action,
    valid_until,assigned_by_principal)
  SELECT gen_random_uuid(),actor,actor,'governance:platform',
    'access.grant.assign.governance.rule.publish','infinity',principal
  WHERE NOT EXISTS (SELECT 1 FROM access.permission_grant
    WHERE scope_id = 'governance:platform' AND action = 'access.grant.assign.governance.rule.publish'
      AND (assigned_by_principal = principal OR recipient_subject = actor));
END $$;

-- Extend the existing bootstrap rather than introducing a second configuration path.
ALTER FUNCTION access.seed_platform_grants(uuid,text) RENAME TO seed_platform_resource_grants;
CREATE FUNCTION access.seed_platform_grants(principal uuid, designation text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM access.seed_platform_resource_grants(principal,designation);
  PERFORM access.seed_rule_publisher_assignment_ceiling(principal,designation);
END $$;

-- Existing deployments receive the same ceiling as future first bootstraps.
-- Use the immutable original episode, never every administrator or grant holder.
SELECT access.seed_rule_publisher_assignment_ceiling(g.principal_id,e.receipt)
FROM access.platform_grant_episode e
JOIN access.principal_permission_grant g ON g.id = e.principal_grant_id
WHERE e.permission = 'platform:grant' AND e.principal_grant_id IS NOT NULL
ORDER BY e.created_at,e.id LIMIT 1;
