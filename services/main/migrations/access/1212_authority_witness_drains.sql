-- Strong revocation fixes the same exact source cut as admission. Generic and
-- catalogue proofs now retain witnesses instead of the older Work columns.
-- Keep every existing edge, private grant, group, role and read-lease case.
CREATE INDEX admission_authority_witness_pending ON access.admission USING gin(authority_witness jsonb_path_ops)
  WHERE state <> 'sealed';
CREATE INDEX admission_representation_pending ON access.admission(represented_representation_id,id)
  WHERE state <> 'sealed';
CREATE INDEX admission_grant_pending ON access.admission(represented_grant_id,id)
  WHERE state <> 'sealed';

CREATE OR REPLACE FUNCTION access.check_revocation_affected_work() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE r access.revocation; linked boolean;
BEGIN
    SELECT * INTO r FROM access.revocation WHERE id = NEW.revocation_id;
    IF r.mode <> 'strong' THEN
        RAISE EXCEPTION 'only a strong revocation drains admitted work' USING ERRCODE = '23514';
    END IF;
    IF NEW.admission_id IS NOT NULL THEN
        SELECT a.state <> 'sealed' AND CASE r.target_kind
            WHEN 'representation_edge' THEN EXISTS (SELECT 1 FROM access.admission_obligation o
                JOIN access.representation_path_step s ON s.path_id = o.path_id
                WHERE o.admission_id = a.id AND s.edge_id = r.representation_edge_id)
            WHEN 'representation' THEN a.represented_representation_id = r.representation_id
                OR a.authority_witness @> jsonb_build_array(jsonb_build_object('table','representation','id',r.representation_id::text))
            WHEN 'permission_grant' THEN a.represented_grant_id = r.permission_grant_id
                OR a.authority_witness @> jsonb_build_array(jsonb_build_object('table','permission_grant','id',r.permission_grant_id::text))
            WHEN 'principal_permission_grant' THEN a.direct_grant_id = r.principal_permission_grant_id
            WHEN 'group_permission_grant' THEN r.group_permission_grant_id
                IN (a.group_grant_id, a.private_group_grant_id)
            WHEN 'role_binding' THEN a.role_binding_id = r.role_binding_id
            ELSE a.private_role_binding_id = r.private_role_binding_id END
        INTO linked FROM access.admission a WHERE a.id = NEW.admission_id;
    ELSIF NEW.search_read_lease_id IS NOT NULL THEN
        SELECT l.state IN ('admitted', 'delivering') AND CASE r.target_kind
            WHEN 'representation' THEN l.representation_id = r.representation_id
            WHEN 'permission_grant' THEN l.grant_id = r.permission_grant_id
            ELSE false END
        INTO linked FROM access.search_read_lease l WHERE l.id = NEW.search_read_lease_id;
    ELSE
        SELECT l.state IN ('admitted', 'delivering') AND CASE r.target_kind
            WHEN 'representation' THEN l.representation_id = r.representation_id
            WHEN 'permission_grant' THEN l.grant_id = r.permission_grant_id
            ELSE false END
        INTO linked FROM access.download_read_lease l WHERE l.id = NEW.download_read_lease_id;
    END IF;
    IF linked IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'affected work is not pending on the revoked source'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;

