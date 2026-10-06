-- One bounded live proof shared by platform authorization and rate-limit trust.
-- A set-returning PL/pgSQL function materializes the whole bounded result before
-- EXISTS can accept a row: overflow cannot turn a partial proof into trust.
CREATE FUNCTION access.read_platform_permissions(subject_principal uuid)
RETURNS TABLE(id uuid, action text, scope_id text, generation bigint,
  valid_until timestamptz, witness text) LANGUAGE plpgsql STABLE AS $$
DECLARE roots uuid[]; membership_witness text; root_count integer;
  proof record; proof_count integer := 0;
BEGIN
  SELECT array_agg(m.group_id ORDER BY m.id), count(*),
    '[' || string_agg(format(
      '{"id":%s,"group_id":%s,"generation":%s,"private_membership_generation":%s}',
      to_json(m.id),to_json(m.group_id),to_json(m.generation::text),
      to_json(m.private_membership_generation::text)), ',' ORDER BY m.id) || ']'
    INTO roots,root_count,membership_witness
    FROM (
      SELECT gm.id,gm.group_id,gm.generation,gm.private_membership_generation
      FROM access.private_group_member gm
      JOIN access.private_membership pm ON pm.id = gm.private_membership_id
      WHERE gm.principal_id = subject_principal AND gm.active
        AND pm.state = 'joined' AND pm.principal_id = gm.principal_id
        AND pm.generation = gm.private_membership_generation
      ORDER BY gm.id LIMIT 17
    ) m;
  IF root_count > 16 THEN
    RAISE EXCEPTION 'Platform membership budget exceeded' USING ERRCODE = '54000';
  END IF;
  FOR proof IN
    WITH RECURSIVE ancestry(group_id,parent_id,depth,path_witness) AS (
      SELECT rg.id,rg.parent_id,0,rg.id::text || ':' || rg.generation::text
        FROM access.recipient_group rg WHERE rg.id = ANY(roots)
      UNION ALL
      SELECT rg.id,rg.parent_id,a.depth+1,
        a.path_witness || ':' || rg.id::text || ':' || rg.generation::text
        FROM access.recipient_group rg JOIN ancestry a ON rg.id = a.parent_id
        WHERE a.depth < 8
    ), direct_proofs AS (
      SELECT g.id,g.action,g.scope_id,g.generation,
        CASE WHEN g.valid_until = 'infinity' THEN NULL ELSE g.valid_until END AS valid_until,
        e.receipt || ':' || g.generation::text AS witness,0 AS depth,NULL::uuid AS parent_id
      FROM access.principal_permission_grant g
      JOIN access.platform_grant_episode e ON e.principal_grant_id = g.id
      WHERE g.principal_id = subject_principal AND g.active AND g.action LIKE 'platform:%'
        AND (g.private_membership_id IS NULL OR EXISTS (
          SELECT 1 FROM access.private_membership pm
          WHERE pm.id = g.private_membership_id AND pm.principal_id = g.principal_id
            AND pm.state = 'joined' AND pm.generation = g.private_membership_generation))
        AND g.valid_until > clock_timestamp()
      ORDER BY g.id LIMIT 129
    ), group_proofs AS (
      SELECT g.id,g.action,g.scope_id,g.generation,
        CASE WHEN g.valid_until = 'infinity' THEN NULL ELSE g.valid_until END AS valid_until,
        e.receipt || ':' || g.generation::text || ':' || a.path_witness || ':' || membership_witness AS witness,
        a.depth,a.parent_id
      FROM ancestry a JOIN access.group_permission_grant g ON g.group_id = a.group_id
      JOIN access.platform_grant_episode e ON e.group_grant_id = g.id
      WHERE g.active AND g.action LIKE 'platform:%' AND g.valid_until > clock_timestamp()
      ORDER BY g.id LIMIT 129
    ) SELECT * FROM direct_proofs UNION ALL SELECT * FROM group_proofs
  LOOP
    proof_count := proof_count + 1;
    IF proof_count > 128 OR (proof.depth = 8 AND proof.parent_id IS NOT NULL) THEN
      RAISE EXCEPTION 'Platform grant budget exceeded' USING ERRCODE = '54000';
    END IF;
    id := proof.id; action := proof.action; scope_id := proof.scope_id;
    generation := proof.generation; valid_until := proof.valid_until; witness := proof.witness;
    RETURN NEXT;
  END LOOP;
END $$;

-- Immutable grant history remembers bootstrap even after revocation. Startup
-- configuration cannot resurrect a previous designation or select a new one.
CREATE INDEX platform_grant_bootstrap_origin ON access.platform_grant_episode(created_at,id)
  WHERE permission = 'platform:grant' AND principal_grant_id IS NOT NULL;

-- 1290 transferred the holder into ordinary grants and detached saved proofs.
DROP TABLE access.platform_administrator;
