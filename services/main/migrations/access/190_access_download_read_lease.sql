-- IAM07: a media download is admitted against its exact Work read authority.
-- Strong revocation fixes these leases into its drain list; an active stream
-- remains pending until the response body closes or is cancelled.
CREATE TABLE access.download_read_lease (
    id uuid PRIMARY KEY,
    principal_id uuid NOT NULL REFERENCES access.principal(id),
    acting_subject text NOT NULL REFERENCES access.authority_subject(id),
    asset_id uuid NOT NULL,
    target text NOT NULL CHECK (target LIKE 'https://rezics.com/id/%'),
    scope_id text NOT NULL REFERENCES access.scope_gate(id),
    representation_id uuid NOT NULL REFERENCES access.representation(id),
    grant_id uuid NOT NULL REFERENCES access.permission_grant(id),
    authority_epoch bigint NOT NULL CHECK (authority_epoch >= 0),
    principal_epoch bigint NOT NULL CHECK (principal_epoch >= 0),
    recovery_generation bigint NOT NULL CHECK (recovery_generation >= 0),
    subject_generation bigint NOT NULL CHECK (subject_generation >= 0),
    representation_generation bigint NOT NULL CHECK (representation_generation >= 0),
    grant_generation bigint NOT NULL CHECK (grant_generation >= 0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    expires_at timestamptz NOT NULL,
    state text NOT NULL CHECK (state IN ('admitted', 'delivering', 'delivered', 'aborted')),
    delivery_started_at timestamptz,
    finished_at timestamptz,
    CONSTRAINT download_read_lease_scope CHECK (scope_id = 'work:read:' || target),
    CONSTRAINT download_read_lease_times CHECK (expires_at > created_at),
    CONSTRAINT download_read_lease_state CHECK (
      (state = 'admitted' AND delivery_started_at IS NULL AND finished_at IS NULL)
      OR (state = 'delivering' AND delivery_started_at IS NOT NULL AND finished_at IS NULL)
      OR (state = 'delivered' AND delivery_started_at IS NOT NULL AND finished_at IS NOT NULL)
      OR (state = 'aborted' AND finished_at IS NOT NULL)
    )
);
CREATE INDEX download_read_pending_scope ON access.download_read_lease (scope_id, id)
    WHERE state IN ('admitted', 'delivering');
CREATE INDEX download_read_pending_principal ON access.download_read_lease (principal_id, id)
    WHERE state IN ('admitted', 'delivering');

ALTER TABLE access.revocation_affected_work
    ADD COLUMN download_read_lease_id uuid REFERENCES access.download_read_lease(id);
ALTER TABLE access.revocation_affected_work
    DROP CONSTRAINT revocation_affected_one_work,
    ADD CONSTRAINT revocation_affected_one_work CHECK
      (num_nonnulls(admission_id, search_read_lease_id, download_read_lease_id) = 1);
CREATE UNIQUE INDEX revocation_affected_download_read ON access.revocation_affected_work
    (download_read_lease_id, revocation_id) WHERE download_read_lease_id IS NOT NULL;

CREATE FUNCTION access.check_download_read_lease_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF (NEW.id, NEW.principal_id, NEW.acting_subject, NEW.asset_id, NEW.target,
        NEW.scope_id, NEW.representation_id, NEW.grant_id, NEW.authority_epoch,
        NEW.principal_epoch, NEW.recovery_generation, NEW.subject_generation,
        NEW.representation_generation, NEW.grant_generation, NEW.created_at, NEW.expires_at)
        IS DISTINCT FROM
       (OLD.id, OLD.principal_id, OLD.acting_subject, OLD.asset_id, OLD.target,
        OLD.scope_id, OLD.representation_id, OLD.grant_id, OLD.authority_epoch,
        OLD.principal_epoch, OLD.recovery_generation, OLD.subject_generation,
        OLD.representation_generation, OLD.grant_generation, OLD.created_at, OLD.expires_at)
        OR NOT ((OLD.state = 'admitted' AND NEW.state IN ('delivering', 'aborted'))
          OR (OLD.state = 'delivering' AND NEW.state IN ('delivered', 'aborted'))) THEN
        RAISE EXCEPTION 'download lease identity is immutable and state transition is invalid'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER download_read_lease_transition BEFORE UPDATE
    ON access.download_read_lease FOR EACH ROW
    EXECUTE FUNCTION access.check_download_read_lease_transition();
CREATE TRIGGER download_read_lease_retained BEFORE DELETE
    ON access.download_read_lease FOR EACH ROW
    EXECUTE FUNCTION access.reject_policy_record_mutation();

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
            WHEN 'representation' THEN a.represented_representation_id = r.representation_id
            WHEN 'permission_grant' THEN a.represented_grant_id = r.permission_grant_id
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

CREATE OR REPLACE FUNCTION access.keep_revocation_completion() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF (NEW.id, NEW.principal_id, NEW.issuer_subject, NEW.mode, NEW.target_kind,
        NEW.representation_id, NEW.permission_grant_id, NEW.principal_permission_grant_id,
        NEW.group_permission_grant_id, NEW.role_binding_id, NEW.private_role_binding_id,
        NEW.target_generation, NEW.scope_id, NEW.fence_authority_epoch,
        NEW.recovery_generation, NEW.affected_work, NEW.requested_at)
        IS DISTINCT FROM
       (OLD.id, OLD.principal_id, OLD.issuer_subject, OLD.mode, OLD.target_kind,
        OLD.representation_id, OLD.permission_grant_id, OLD.principal_permission_grant_id,
        OLD.group_permission_grant_id, OLD.role_binding_id, OLD.private_role_binding_id,
        OLD.target_generation, OLD.scope_id, OLD.fence_authority_epoch,
        OLD.recovery_generation, OLD.affected_work, OLD.requested_at)
        OR OLD.state <> 'draining' OR NEW.state <> 'completed' THEN
        RAISE EXCEPTION 'revocation identity is immutable and only draining completes'
            USING ERRCODE = '23514';
    END IF;
    IF EXISTS (SELECT 1 FROM access.revocation_affected_work w
            JOIN access.admission a ON a.id = w.admission_id
            WHERE w.revocation_id = NEW.id AND a.state <> 'sealed')
        OR EXISTS (SELECT 1 FROM access.revocation_affected_work w
            JOIN access.search_read_lease l ON l.id = w.search_read_lease_id
            WHERE w.revocation_id = NEW.id AND l.state IN ('admitted', 'delivering'))
        OR EXISTS (SELECT 1 FROM access.revocation_affected_work w
            JOIN access.download_read_lease l ON l.id = w.download_read_lease_id
            WHERE w.revocation_id = NEW.id AND l.state IN ('admitted', 'delivering')) THEN
        RAISE EXCEPTION 'revocation still has admitted work pending' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
