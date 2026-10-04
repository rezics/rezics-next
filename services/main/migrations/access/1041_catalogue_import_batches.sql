-- Dedicated explicit-grant catalogue import. One authority cut and one durable
-- admission transaction cover <=128 independent creation receipts. No baseline,
-- administrator shortcut, Realm policy, editorial permit or private authority.
CREATE OR REPLACE FUNCTION access.catalogue_import_admit(
  issuer text, account_subject text, actor text, items jsonb
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  gate access.scope_gate%ROWTYPE;
  principal access.principal%ROWTYPE;
  prior access.admission%ROWTYPE;
  item jsonb;
  admitted jsonb := '[]';
  permitted boolean := false;
  replayed boolean;
  dispatch boolean;
BEGIN
  IF jsonb_typeof(items) IS DISTINCT FROM 'array' OR jsonb_array_length(items) NOT BETWEEN 1 AND 128 THEN
    RAISE EXCEPTION 'invalid catalogue admission batch';
  END IF;
  SELECT * INTO gate FROM access.scope_gate WHERE id = 'work:create:catalogue-import' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'catalogue scope unavailable'; END IF;
  SELECT * INTO principal FROM access.principal
    WHERE account_issuer = issuer AND access.principal.account_subject = catalogue_import_admit.account_subject FOR SHARE;
  IF NOT FOUND OR NOT principal.active THEN RETURN jsonb_build_object('principalId', null, 'items', '[]'::jsonb); END IF;
  PERFORM 1 FROM access.authority_subject WHERE id = actor AND active AND kind = 'agent' FOR SHARE;
  IF FOUND THEN
    PERFORM 1 FROM access.representation WHERE principal_id = principal.id AND subject_id = actor
      AND action = 'work.create' AND active AND valid_until > clock_timestamp() ORDER BY id LIMIT 1 FOR SHARE;
    IF FOUND THEN
      PERFORM 1 FROM access.permission_grant WHERE recipient_subject = actor
        AND scope_id = gate.id AND action = 'work.create' AND active AND valid_until > clock_timestamp()
        AND membership_id IS NULL ORDER BY id LIMIT 1 FOR SHARE;
      permitted := FOUND;
    END IF;
  END IF;
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
        AND prior.authority_epoch = gate.authority_epoch;
      IF dispatch AND prior.state = 'registered' THEN
        UPDATE access.admission SET state = 'claimed', claimed_at = clock_timestamp() WHERE id = prior.id RETURNING * INTO prior;
        INSERT INTO access.outbox(id,kind,admission_id,scope_id,authority_epoch)
          VALUES(gen_random_uuid(),'admission.claimed',prior.id,gate.id,prior.authority_epoch);
      END IF;
    ELSIF dispatch THEN
      INSERT INTO access.admission(id,principal_id,acting_subject,authority_path,scope_id,action,
        idempotency_key,request_digest,authority_epoch,expires_at,state,claimed_at)
      VALUES(gen_random_uuid(),principal.id,actor,'represented-agent',gate.id,'work.create',
        item->>'key',item->>'digest',gate.authority_epoch,clock_timestamp() + interval '30 seconds','claimed',clock_timestamp())
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
CREATE OR REPLACE FUNCTION access.catalogue_import_outcomes(proofs jsonb)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  proof jsonb;
  prior access.admission%ROWTYPE;
  expected_receipt text;
  inserted_work text;
BEGIN
  IF jsonb_typeof(proofs) IS DISTINCT FROM 'array' OR jsonb_array_length(proofs) > 128 THEN RAISE EXCEPTION 'invalid catalogue outcomes'; END IF;
  PERFORM 1 FROM access.scope_gate WHERE id = 'work:create:catalogue-import' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'catalogue scope unavailable'; END IF;
  FOR proof IN SELECT value FROM jsonb_array_elements(proofs) LOOP
    SELECT * INTO prior FROM access.admission WHERE id = (proof->>'admissionId')::uuid FOR UPDATE;
    expected_receipt := 'urn:rezics:receipt:' || encode(sha256(convert_to(prior.id::text,'UTF8') || decode('00','hex') || convert_to('create-metadata-work','UTF8')),'hex');
    IF NOT FOUND OR prior.action <> 'work.create' OR prior.scope_id <> 'work:create:catalogue-import'
      OR proof->>'scope' IS DISTINCT FROM prior.scope_id OR proof->>'requestDigest' IS DISTINCT FROM prior.request_digest
      OR proof->>'authorityEpoch' IS DISTINCT FROM prior.authority_epoch::text OR proof->>'receipt' IS DISTINCT FROM expected_receipt
      OR coalesce(proof->>'outcome','') NOT IN ('succeeded','cancelled') OR coalesce(proof->>'sequence','') !~ '^[0-9]+$'
      OR coalesce(proof->>'dataEpoch','') = '' THEN RAISE EXCEPTION 'catalogue terminal proof differs'; END IF;
    IF prior.state = 'sealed' THEN
      IF prior.graph_receipt <> proof->>'receipt' OR prior.graph_outcome <> proof->>'outcome'
        OR prior.graph_data_epoch <> proof->>'dataEpoch' OR prior.graph_sequence <> proof->>'sequence' THEN
        RAISE EXCEPTION 'catalogue admission already sealed differently';
      END IF;
    ELSIF proof->>'outcome' = 'succeeded' AND prior.state <> 'claimed' THEN
      RAISE EXCEPTION 'unclaimed catalogue admission cannot succeed';
    END IF;
    IF proof->>'outcome' = 'succeeded' THEN
      IF coalesce(proof->>'work','') = '' OR coalesce(proof->>'mainVersion','') = '' THEN
        RAISE EXCEPTION 'catalogue success has no Work identity';
      END IF;
      inserted_work := NULL;
      INSERT INTO access.work_maintainer_set(work,main_version,creation_admission)
        VALUES(proof->>'work',proof->>'mainVersion',prior.id) ON CONFLICT(work) DO NOTHING RETURNING work INTO inserted_work;
      IF inserted_work IS NOT NULL THEN
        INSERT INTO access.work_maintainer(work,agent) VALUES(inserted_work,prior.acting_subject);
        INSERT INTO access.work_maintainer_receipt(id,work,principal_id,idempotency_key,request_digest,actor,target,action,generation,maintainers)
          VALUES(prior.id,inserted_work,prior.principal_id,'work-create:' || prior.id::text,prior.request_digest,
            prior.acting_subject,prior.acting_subject,'create',0,jsonb_build_array(prior.acting_subject));
      END IF;
    END IF;
    IF prior.state <> 'sealed' THEN
      UPDATE access.admission SET state = 'sealed', graph_receipt = proof->>'receipt', graph_outcome = proof->>'outcome',
        graph_data_epoch = proof->>'dataEpoch', graph_sequence = proof->>'sequence', sealed_at = clock_timestamp() WHERE id = prior.id;
      INSERT INTO access.outbox(id,kind,admission_id,scope_id,authority_epoch)
        VALUES(gen_random_uuid(),'admission.sealed',prior.id,prior.scope_id,prior.authority_epoch);
    END IF;
  END LOOP;
END $$;
