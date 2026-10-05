-- Catalogue batches select four indexed authority rows once; exact replay checks
-- those same generations, never an alternative mandate or grant. Scope closure
-- still fences the batch. Terminal graph acknowledgements retain their contract.
CREATE OR REPLACE FUNCTION access.catalogue_import_admit(
  issuer text, account_subject text, actor text, items jsonb
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  gate access.scope_gate%ROWTYPE;
  principal access.principal%ROWTYPE;
  prior access.admission%ROWTYPE;
  mandate access.representation%ROWTYPE;
  grant_row access.permission_grant%ROWTYPE;
  subject_generation bigint;
  witness jsonb;
  item jsonb;
  admitted jsonb := '[]';
  permitted boolean := false;
  replayed boolean;
  dispatch boolean;
BEGIN
  IF jsonb_typeof(items) IS DISTINCT FROM 'array' OR jsonb_array_length(items) NOT BETWEEN 1 AND 128 THEN
    RAISE EXCEPTION 'invalid catalogue admission batch';
  END IF;
  SELECT * INTO gate FROM access.scope_gate WHERE id = 'work:create:catalogue-import' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'catalogue scope unavailable'; END IF;
  SELECT * INTO principal FROM access.principal
    WHERE account_issuer = issuer AND access.principal.account_subject = catalogue_import_admit.account_subject FOR SHARE;
  IF NOT FOUND OR NOT principal.active THEN RETURN jsonb_build_object('principalId', null, 'items', '[]'::jsonb); END IF;
  SELECT generation INTO subject_generation FROM access.authority_subject WHERE id = actor AND active AND kind = 'agent' FOR SHARE;
  IF FOUND THEN
    SELECT * INTO mandate FROM access.representation WHERE principal_id = principal.id AND subject_id = actor
      AND action = 'work.create' AND active AND valid_until > clock_timestamp() ORDER BY id LIMIT 1 FOR SHARE;
    IF FOUND THEN
      SELECT * INTO grant_row FROM access.permission_grant WHERE recipient_subject = actor
        AND scope_id = gate.id AND action = 'work.create' AND active AND valid_until > clock_timestamp()
        AND membership_id IS NULL ORDER BY id LIMIT 1 FOR SHARE;
      permitted := FOUND;
    END IF;
  END IF;
  IF permitted THEN
    witness := jsonb_build_array(
      jsonb_build_object('table','principal','id',principal.id::text,'generation',principal.enforcement_epoch::text),
      jsonb_build_object('table','authority_subject','id',actor,'generation',subject_generation::text),
      jsonb_build_object('table','representation','id',mandate.id::text,'generation',mandate.generation::text),
      jsonb_build_object('table','permission_grant','id',grant_row.id::text,'generation',grant_row.generation::text));
  END IF;
  -- Match ordinary admission's principal/action/key lock. Acquire the bounded
  -- batch in key order before any admission row, so overlapping reordered
  -- batches cannot deadlock and responses retain their original input order.
  FOR item IN SELECT value FROM jsonb_array_elements(items) ORDER BY value->>'key' LOOP
    IF coalesce(item->>'key','') !~ '^[A-Za-z0-9:_./-]{1,128}$' OR coalesce(item->>'digest','') !~ '^[0-9a-f]{64}$' THEN
      RAISE EXCEPTION 'invalid catalogue item';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('admission:' || principal.id::text || ':work.create:' || (item->>'key'), 0));
  END LOOP;
  FOR item IN SELECT value FROM jsonb_array_elements(items) LOOP
    IF coalesce(item->>'key','') !~ '^[A-Za-z0-9:_./-]{1,128}$' OR coalesce(item->>'digest','') !~ '^[0-9a-f]{64}$' THEN
      RAISE EXCEPTION 'invalid catalogue item';
    END IF;
    SELECT * INTO prior FROM access.admission WHERE principal_id = principal.id AND action = 'work.create'
      AND idempotency_key = item->>'key' FOR UPDATE;
    replayed := FOUND;
    IF replayed AND (prior.scope_id <> gate.id OR prior.acting_subject <> actor
      OR prior.authority_path <> 'represented-agent' OR prior.request_digest <> item->>'digest') THEN
      admitted := admitted || jsonb_build_array(jsonb_build_object('status', 'conflict'));
      CONTINUE;
    END IF;
    dispatch := gate.open AND gate.dispatch_open AND permitted;
    IF replayed THEN
      dispatch := dispatch AND prior.state <> 'sealed' AND prior.expires_at > clock_timestamp()
        AND prior.authority_epoch = gate.authority_epoch
        AND prior.authority_witness IS NOT NULL
        AND (SELECT count(*) = 4 FROM jsonb_array_elements(prior.authority_witness) w
          WHERE CASE w->>'table'
            WHEN 'principal' THEN EXISTS (SELECT 1 FROM access.principal p WHERE p.id = (w->>'id')::uuid
              AND p.id = principal.id AND p.active AND p.enforcement_epoch::text = w->>'generation')
            WHEN 'authority_subject' THEN EXISTS (SELECT 1 FROM access.authority_subject s WHERE s.id = w->>'id'
              AND s.id = actor AND s.active AND s.generation::text = w->>'generation')
            WHEN 'representation' THEN EXISTS (SELECT 1 FROM access.representation r WHERE r.id = (w->>'id')::uuid
              AND r.principal_id = principal.id AND r.subject_id = actor AND r.action = 'work.create'
              AND r.active AND r.valid_until > clock_timestamp() AND r.generation::text = w->>'generation' FOR SHARE)
            WHEN 'permission_grant' THEN EXISTS (SELECT 1 FROM access.permission_grant g WHERE g.id = (w->>'id')::uuid
              AND g.recipient_subject = actor AND g.scope_id = gate.id AND g.action = 'work.create'
              AND g.active AND g.valid_until > clock_timestamp() AND g.generation::text = w->>'generation' FOR SHARE)
            ELSE false END);
      IF dispatch AND prior.state = 'registered' THEN
        UPDATE access.admission SET state = 'claimed', claimed_at = clock_timestamp() WHERE id = prior.id RETURNING * INTO prior;
        INSERT INTO access.outbox(id,kind,admission_id,scope_id,authority_epoch)
          VALUES(gen_random_uuid(),'admission.claimed',prior.id,gate.id,prior.authority_epoch);
      END IF;
    ELSIF dispatch THEN
      INSERT INTO access.admission(id,principal_id,acting_subject,authority_path,scope_id,action,
        idempotency_key,request_digest,authority_epoch,expires_at,state,claimed_at,authority_witness)
      VALUES(gen_random_uuid(),principal.id,actor,'represented-agent',gate.id,'work.create',
        item->>'key',item->>'digest',gate.authority_epoch,clock_timestamp() + interval '30 seconds','claimed',clock_timestamp(),witness)
      RETURNING * INTO prior;
      INSERT INTO access.admission_receipt(admission_id,principal_id,action,idempotency_key,request_digest,outcome)
        VALUES(prior.id,principal.id,'work.create',prior.idempotency_key,prior.request_digest,'registered');
      INSERT INTO access.outbox(id,kind,admission_id,scope_id,authority_epoch) VALUES
        (gen_random_uuid(),'admission.registered',prior.id,gate.id,gate.authority_epoch),
        (gen_random_uuid(),'admission.claimed',prior.id,gate.id,gate.authority_epoch);
    ELSE
      admitted := admitted || jsonb_build_array(jsonb_build_object('status', 'denied'));
      CONTINUE;
    END IF;
    admitted := admitted || jsonb_build_array(jsonb_build_object('admission', to_jsonb(prior),
      'dispatchEligible', dispatch, 'replayed', replayed));
  END LOOP;
  RETURN jsonb_build_object('principalId', principal.id, 'items', admitted);
END $$;

-- Proof acknowledgement is atomic across the physical Jena batch. Ambiguity
-- leaves the durable graph receipts to reconcile on the same per-item keys.
