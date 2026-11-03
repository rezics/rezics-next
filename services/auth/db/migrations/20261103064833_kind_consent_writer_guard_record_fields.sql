-- migrate:up
CREATE OR REPLACE FUNCTION auth_kind_consent_writer_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  account_key text;
  client_key text;
  operation text;
  transition auth_kind_consent_transition%ROWTYPE;
  required boolean := false;
  authority_change boolean := false;
BEGIN
  IF TG_TABLE_NAME='auth_consent' THEN
    client_key:=CASE WHEN TG_OP='DELETE' THEN OLD.client_id ELSE NEW.client_id END;
    account_key:=CASE WHEN TG_OP='DELETE' THEN OLD.account_id ELSE NEW.account_id END;
    IF TG_OP='DELETE' THEN
      authority_change:=true;
      required:=EXISTS(SELECT 1 FROM auth_kind_consent_dependency d WHERE d.active AND d.account_id=OLD.account_id AND d.client_id=OLD.client_id);
      operation:='consent-delete';
    ELSIF TG_OP='INSERT' THEN
      authority_change:=true;
      required:=EXISTS(SELECT 1 FROM auth_kind_consent_dependency d WHERE d.active AND d.account_id=NEW.account_id AND d.client_id=NEW.client_id);
      operation:='consent-upsert';
    ELSE
      authority_change:=ROW(NEW.scopes,NEW.pending_scopes,NEW.pending_reference) IS DISTINCT FROM ROW(OLD.scopes,OLD.pending_scopes,OLD.pending_reference);
      required:=authority_change
        AND EXISTS(SELECT 1 FROM auth_kind_consent_dependency d WHERE d.active AND d.account_id=NEW.account_id AND d.client_id=NEW.client_id);
      operation:=CASE WHEN NEW.scopes IS NOT DISTINCT FROM OLD.scopes THEN 'consent-pending' ELSE 'consent-upsert' END;
    END IF;
  ELSIF TG_TABLE_NAME='auth_client' THEN
    client_key:=CASE WHEN TG_OP='DELETE' THEN OLD.client_id ELSE NEW.client_id END;
    IF TG_OP='DELETE' THEN
      authority_change:=true;
      required:=EXISTS(SELECT 1 FROM auth_kind_consent_dependency d WHERE d.active AND d.client_id=client_key);
    ELSE
      authority_change:=ROW(NEW.scopes,NEW.first_party,NEW.erasure_fenced,NEW.disabled) IS DISTINCT FROM ROW(OLD.scopes,OLD.first_party,OLD.erasure_fenced,OLD.disabled);
      required:=authority_change
        AND EXISTS(SELECT 1 FROM auth_kind_consent_dependency d WHERE d.active AND d.client_id=client_key);
    END IF;
    operation:=CASE WHEN TG_OP='UPDATE' AND
      ROW(NEW.disabled,NEW.erasure_fenced) IS DISTINCT FROM ROW(OLD.disabled,OLD.erasure_fenced)
      THEN 'client-erasure-fence' ELSE 'client-config' END;
  ELSIF TG_TABLE_NAME='auth_client_reduction' THEN
    client_key:=CASE WHEN TG_OP='DELETE' THEN OLD.client_id ELSE NEW.client_id END;
    authority_change:=TG_OP<>'UPDATE';
    required:=authority_change AND EXISTS(SELECT 1 FROM auth_kind_consent_dependency d WHERE d.active AND d.client_id=client_key);
    operation:=CASE WHEN TG_OP='DELETE' THEN 'client-reduction-finish' ELSE 'client-reduction-start' END;
  ELSIF TG_TABLE_NAME='auth_client_coverage' THEN
    client_key:=CASE WHEN TG_OP='DELETE' THEN OLD.client_id ELSE NEW.client_id END;
    IF TG_OP='DELETE' THEN
      authority_change:=true;
      required:=EXISTS(SELECT 1 FROM auth_kind_consent_dependency d WHERE d.active AND d.client_id=client_key);
    ELSE
      authority_change:=(TG_OP='INSERT' AND NEW.ready) OR
        (TG_OP='UPDATE' AND NEW.ready IS DISTINCT FROM OLD.ready);
      required:=authority_change AND
        EXISTS(SELECT 1 FROM auth_kind_consent_dependency d WHERE d.active AND d.client_id=client_key);
    END IF;
    operation:='client-coverage';
  ELSE
    RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF NOT authority_change THEN RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END IF;
  -- This is the database-side serialization point for legacy/direct writers.
  -- A direct mutation cannot race an enrollment snapshot or slip through after
  -- a page has fenced its rows but before the exact transition is applied.
  PERFORM pg_advisory_xact_lock(hashtextextended('auth-kind-consent-frontier',0));
  IF TG_TABLE_NAME='auth_consent' THEN
    required:=EXISTS(SELECT 1 FROM auth_kind_consent_dependency d WHERE d.active AND d.account_id=account_key AND d.client_id=client_key)
      OR EXISTS(SELECT 1 FROM auth_kind_consent_transition t WHERE t.state<>'applied' AND
        (t.transition_kind='restore' OR (t.client_id=client_key AND (t.account_id IS NULL OR t.account_id=account_key))));
  ELSE
    required:=EXISTS(SELECT 1 FROM auth_kind_consent_dependency d WHERE d.active AND d.client_id=client_key)
      OR EXISTS(SELECT 1 FROM auth_kind_consent_transition t WHERE t.state<>'applied' AND
        (t.transition_kind='restore' OR (t.client_id=client_key AND (t.account_id IS NULL OR t.account_id=account_key))));
  END IF;
  IF NOT required THEN RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END IF;
  SELECT * INTO transition FROM auth_kind_consent_transition t
  WHERE t.transition_id::text=current_setting('auth.kind_consent_transition_id',true)
    AND t.state='ready' AND t.client_id=client_key
    AND (t.account_id IS NULL OR t.account_id=account_key)
    AND (t.target->>'operation'=operation OR
      (TG_TABLE_NAME='auth_client_coverage' AND TG_OP='INSERT' AND operation='client-coverage'
       AND t.target->>'operation'='client-config'));
  IF NOT FOUND THEN RAISE EXCEPTION 'Kind consent dependency closure required before Auth write' USING ERRCODE='55000'; END IF;
  IF EXISTS(SELECT 1 FROM auth_kind_consent_dependency d WHERE d.active AND d.client_id=client_key
      AND (transition.account_id IS NULL OR d.account_id=transition.account_id)
      AND d.enrollment_seq<=transition.frontier_seq) THEN
    RAISE EXCEPTION 'Kind consent dependency closure is incomplete' USING ERRCODE='55000';
  END IF;
  IF TG_TABLE_NAME='auth_consent' THEN
    IF operation='consent-upsert' AND TG_OP<>'DELETE' THEN
      IF transition.target->'scopes' IS DISTINCT FROM to_jsonb(NEW.scopes) OR
        (transition.target ? 'pendingScopes' AND transition.target->'pendingScopes' IS DISTINCT FROM COALESCE(to_jsonb(NEW.pending_scopes),'null'::jsonb)) OR
        (transition.target ? 'pendingReference' AND transition.target->>'pendingReference' IS DISTINCT FROM NEW.pending_reference) THEN
        RAISE EXCEPTION 'Kind consent transition target mismatch' USING ERRCODE='23514';
      END IF;
    ELSIF operation='consent-pending' AND TG_OP='UPDATE' THEN
      IF transition.target->'pendingScopes' IS DISTINCT FROM to_jsonb(NEW.pending_scopes) OR
        transition.target->>'pendingReference' IS DISTINCT FROM NEW.pending_reference THEN
        RAISE EXCEPTION 'Kind pending consent transition target mismatch' USING ERRCODE='23514';
      END IF;
    END IF;
  ELSIF TG_TABLE_NAME='auth_client' THEN
    IF TG_OP='UPDATE' THEN
      IF operation='client-config' THEN
        IF transition.target->'scopes' IS DISTINCT FROM to_jsonb(NEW.scopes) OR
          transition.target->>'firstParty' IS DISTINCT FROM to_jsonb(NEW.first_party)#>>'{}' THEN
          RAISE EXCEPTION 'Kind client transition target mismatch' USING ERRCODE='23514';
        END IF;
      ELSIF operation='client-erasure-fence' AND (NOT NEW.erasure_fenced OR NOT NEW.disabled) THEN
        RAISE EXCEPTION 'Kind client erasure fence target mismatch' USING ERRCODE='23514';
      END IF;
    ELSIF TG_OP='DELETE' AND transition.target->>'operation'<>'client-delete' THEN
      RAISE EXCEPTION 'Kind client deletion transition target mismatch' USING ERRCODE='23514';
    END IF;
  ELSIF TG_TABLE_NAME='auth_client_coverage' THEN
    IF TG_OP<>'DELETE' THEN
      IF transition.target->>'operation'='client-coverage' AND
        transition.target->>'ready' IS DISTINCT FROM to_jsonb(NEW.ready)#>>'{}' THEN
        RAISE EXCEPTION 'Kind client coverage transition target mismatch' USING ERRCODE='23514';
      ELSIF TG_OP='INSERT' AND transition.target->>'operation'='client-config' AND
        (NOT NEW.ready OR NOT EXISTS(
          SELECT 1 FROM auth_client c WHERE c.client_id=client_key
            AND to_jsonb(c.scopes)=transition.target->'scopes'
            AND (to_jsonb(c.first_party)#>>'{}')=transition.target->>'firstParty'
        )) THEN
        RAISE EXCEPTION 'Kind client coverage is outside client transition target' USING ERRCODE='23514';
      END IF;
    END IF;
  ELSIF TG_TABLE_NAME='auth_client_reduction' THEN
    IF TG_OP='INSERT' THEN
      IF transition.target->>'operationId' IS DISTINCT FROM NEW.operation_id OR
        transition.target->'scopes' IS DISTINCT FROM to_jsonb(NEW.scopes) OR
        transition.target->>'firstParty' IS DISTINCT FROM to_jsonb(NEW.first_party)#>>'{}' THEN
        RAISE EXCEPTION 'Kind client reduction start target mismatch' USING ERRCODE='23514';
      END IF;
    ELSIF TG_OP='DELETE' THEN
      IF transition.target->>'operationId' IS DISTINCT FROM OLD.operation_id OR
        transition.target->'scopes' IS DISTINCT FROM to_jsonb(OLD.scopes) OR
        transition.target->>'firstParty' IS DISTINCT FROM to_jsonb(OLD.first_party)#>>'{}' THEN
        RAISE EXCEPTION 'Kind client reduction finish target mismatch' USING ERRCODE='23514';
      END IF;
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;

-- migrate:down
CREATE OR REPLACE FUNCTION auth_kind_consent_writer_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  account_key text;
  client_key text;
  operation text;
  transition auth_kind_consent_transition%ROWTYPE;
  required boolean := false;
  authority_change boolean := false;
BEGIN
  IF TG_TABLE_NAME='auth_consent' THEN
    client_key:=CASE WHEN TG_OP='DELETE' THEN OLD.client_id ELSE NEW.client_id END;
    account_key:=CASE WHEN TG_OP='DELETE' THEN OLD.account_id ELSE NEW.account_id END;
    IF TG_OP='DELETE' THEN
      authority_change:=true;
      required:=EXISTS(SELECT 1 FROM auth_kind_consent_dependency d WHERE d.active AND d.account_id=OLD.account_id AND d.client_id=OLD.client_id);
      operation:='consent-delete';
    ELSIF TG_OP='INSERT' THEN
      authority_change:=true;
      required:=EXISTS(SELECT 1 FROM auth_kind_consent_dependency d WHERE d.active AND d.account_id=NEW.account_id AND d.client_id=NEW.client_id);
      operation:='consent-upsert';
    ELSE
      authority_change:=ROW(NEW.scopes,NEW.pending_scopes,NEW.pending_reference) IS DISTINCT FROM ROW(OLD.scopes,OLD.pending_scopes,OLD.pending_reference);
      required:=authority_change
        AND EXISTS(SELECT 1 FROM auth_kind_consent_dependency d WHERE d.active AND d.account_id=NEW.account_id AND d.client_id=NEW.client_id);
      operation:=CASE WHEN NEW.scopes IS NOT DISTINCT FROM OLD.scopes THEN 'consent-pending' ELSE 'consent-upsert' END;
    END IF;
  ELSIF TG_TABLE_NAME='auth_client' THEN
    client_key:=CASE WHEN TG_OP='DELETE' THEN OLD.client_id ELSE NEW.client_id END;
    IF TG_OP='DELETE' THEN
      authority_change:=true;
      required:=EXISTS(SELECT 1 FROM auth_kind_consent_dependency d WHERE d.active AND d.client_id=client_key);
    ELSE
      authority_change:=ROW(NEW.scopes,NEW.first_party,NEW.erasure_fenced,NEW.disabled) IS DISTINCT FROM ROW(OLD.scopes,OLD.first_party,OLD.erasure_fenced,OLD.disabled);
      required:=authority_change
        AND EXISTS(SELECT 1 FROM auth_kind_consent_dependency d WHERE d.active AND d.client_id=client_key);
    END IF;
    operation:=CASE WHEN TG_OP='UPDATE' AND
      ROW(NEW.disabled,NEW.erasure_fenced) IS DISTINCT FROM ROW(OLD.disabled,OLD.erasure_fenced)
      THEN 'client-erasure-fence' ELSE 'client-config' END;
  ELSIF TG_TABLE_NAME='auth_client_reduction' THEN
    client_key:=CASE WHEN TG_OP='DELETE' THEN OLD.client_id ELSE NEW.client_id END;
    authority_change:=TG_OP<>'UPDATE';
    required:=authority_change AND EXISTS(SELECT 1 FROM auth_kind_consent_dependency d WHERE d.active AND d.client_id=client_key);
    operation:=CASE WHEN TG_OP='DELETE' THEN 'client-reduction-finish' ELSE 'client-reduction-start' END;
  ELSIF TG_TABLE_NAME='auth_client_coverage' THEN
    client_key:=CASE WHEN TG_OP='DELETE' THEN OLD.client_id ELSE NEW.client_id END;
    IF TG_OP='DELETE' THEN
      authority_change:=true;
      required:=EXISTS(SELECT 1 FROM auth_kind_consent_dependency d WHERE d.active AND d.client_id=client_key);
    ELSE
      authority_change:=(TG_OP='INSERT' AND NEW.ready) OR
        (TG_OP='UPDATE' AND NEW.ready IS DISTINCT FROM OLD.ready);
      required:=authority_change AND
        EXISTS(SELECT 1 FROM auth_kind_consent_dependency d WHERE d.active AND d.client_id=client_key);
    END IF;
    operation:='client-coverage';
  ELSE
    RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF NOT authority_change THEN RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END IF;
  -- This is the database-side serialization point for legacy/direct writers.
  -- A direct mutation cannot race an enrollment snapshot or slip through after
  -- a page has fenced its rows but before the exact transition is applied.
  PERFORM pg_advisory_xact_lock(hashtextextended('auth-kind-consent-frontier',0));
  IF TG_TABLE_NAME='auth_consent' THEN
    required:=EXISTS(SELECT 1 FROM auth_kind_consent_dependency d WHERE d.active AND d.account_id=account_key AND d.client_id=client_key)
      OR EXISTS(SELECT 1 FROM auth_kind_consent_transition t WHERE t.state<>'applied' AND
        (t.transition_kind='restore' OR (t.client_id=client_key AND (t.account_id IS NULL OR t.account_id=account_key))));
  ELSE
    required:=EXISTS(SELECT 1 FROM auth_kind_consent_dependency d WHERE d.active AND d.client_id=client_key)
      OR EXISTS(SELECT 1 FROM auth_kind_consent_transition t WHERE t.state<>'applied' AND
        (t.transition_kind='restore' OR (t.client_id=client_key AND (t.account_id IS NULL OR t.account_id=account_key))));
  END IF;
  IF NOT required THEN RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END IF;
  SELECT * INTO transition FROM auth_kind_consent_transition t
  WHERE t.transition_id::text=current_setting('auth.kind_consent_transition_id',true)
    AND t.state='ready' AND t.client_id=client_key
    AND (t.account_id IS NULL OR t.account_id=account_key)
    AND (t.target->>'operation'=operation OR
      (TG_TABLE_NAME='auth_client_coverage' AND TG_OP='INSERT' AND operation='client-coverage'
       AND t.target->>'operation'='client-config'));
  IF NOT FOUND THEN RAISE EXCEPTION 'Kind consent dependency closure required before Auth write' USING ERRCODE='55000'; END IF;
  IF EXISTS(SELECT 1 FROM auth_kind_consent_dependency d WHERE d.active AND d.client_id=client_key
      AND (transition.account_id IS NULL OR d.account_id=transition.account_id)
      AND d.enrollment_seq<=transition.frontier_seq) THEN
    RAISE EXCEPTION 'Kind consent dependency closure is incomplete' USING ERRCODE='55000';
  END IF;
  IF TG_TABLE_NAME='auth_consent' THEN
    IF operation='consent-upsert' AND TG_OP<>'DELETE' AND (
      transition.target->'scopes' IS DISTINCT FROM to_jsonb(NEW.scopes) OR
      (transition.target ? 'pendingScopes' AND transition.target->'pendingScopes' IS DISTINCT FROM COALESCE(to_jsonb(NEW.pending_scopes),'null'::jsonb)) OR
      (transition.target ? 'pendingReference' AND transition.target->>'pendingReference' IS DISTINCT FROM NEW.pending_reference)
    ) THEN
      RAISE EXCEPTION 'Kind consent transition target mismatch' USING ERRCODE='23514';
    END IF;
    IF operation='consent-pending' AND TG_OP='UPDATE' AND (
      transition.target->'pendingScopes' IS DISTINCT FROM to_jsonb(NEW.pending_scopes) OR
      transition.target->>'pendingReference' IS DISTINCT FROM NEW.pending_reference
    ) THEN RAISE EXCEPTION 'Kind pending consent transition target mismatch' USING ERRCODE='23514'; END IF;
  ELSIF TG_TABLE_NAME='auth_client' AND TG_OP='UPDATE' AND operation='client-config' AND (
    transition.target->'scopes' IS DISTINCT FROM to_jsonb(NEW.scopes) OR
    transition.target->>'firstParty' IS DISTINCT FROM to_jsonb(NEW.first_party)#>>'{}'
  ) THEN RAISE EXCEPTION 'Kind client transition target mismatch' USING ERRCODE='23514';
  ELSIF TG_TABLE_NAME='auth_client' AND TG_OP='UPDATE' AND operation='client-erasure-fence' AND (
    NOT NEW.erasure_fenced OR NOT NEW.disabled
  ) THEN RAISE EXCEPTION 'Kind client erasure fence target mismatch' USING ERRCODE='23514';
  ELSIF TG_TABLE_NAME='auth_client' AND TG_OP='DELETE' AND transition.target->>'operation'<>'client-delete' THEN
    RAISE EXCEPTION 'Kind client deletion transition target mismatch' USING ERRCODE='23514';
  ELSIF TG_TABLE_NAME='auth_client_coverage' AND TG_OP<>'DELETE' AND
    transition.target->>'operation'='client-coverage' AND
    transition.target->>'ready' IS DISTINCT FROM to_jsonb(NEW.ready)#>>'{}' THEN
    RAISE EXCEPTION 'Kind client coverage transition target mismatch' USING ERRCODE='23514';
  ELSIF TG_TABLE_NAME='auth_client_coverage' AND TG_OP='INSERT' AND
    transition.target->>'operation'='client-config' AND
    (NOT NEW.ready OR NOT EXISTS(
      SELECT 1 FROM auth_client c WHERE c.client_id=client_key
        AND to_jsonb(c.scopes)=transition.target->'scopes'
        AND (to_jsonb(c.first_party)#>>'{}')=transition.target->>'firstParty'
    )) THEN
    RAISE EXCEPTION 'Kind client coverage is outside client transition target' USING ERRCODE='23514';
  ELSIF TG_TABLE_NAME='auth_client_reduction' AND TG_OP='INSERT' AND (
    transition.target->>'operationId' IS DISTINCT FROM NEW.operation_id OR
    transition.target->'scopes' IS DISTINCT FROM to_jsonb(NEW.scopes) OR
    transition.target->>'firstParty' IS DISTINCT FROM to_jsonb(NEW.first_party)#>>'{}'
  ) THEN RAISE EXCEPTION 'Kind client reduction start target mismatch' USING ERRCODE='23514';
  ELSIF TG_TABLE_NAME='auth_client_reduction' AND TG_OP='DELETE' AND (
    transition.target->>'operationId' IS DISTINCT FROM OLD.operation_id OR
    transition.target->'scopes' IS DISTINCT FROM to_jsonb(OLD.scopes) OR
    transition.target->>'firstParty' IS DISTINCT FROM to_jsonb(OLD.first_party)#>>'{}'
  ) THEN RAISE EXCEPTION 'Kind client reduction finish target mismatch' USING ERRCODE='23514';
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
