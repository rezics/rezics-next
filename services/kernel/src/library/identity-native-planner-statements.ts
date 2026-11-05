/** Exact native SQL identities. Each cost counts index/foreign-key/control probes inclusively.
 * Range descriptors add one EOF slot to the admitted LIMIT; point descriptors never scale with result rows.
 * Zero witnessKeys: these are structural native operations, never permission or membership witnesses.
 */
export const libraryIdentitySQL = Object.freeze({
  oldFacts:
    'SELECT stored_subject_id::text AS "storedSubjectId",fact_id::text AS "factId"\n        FROM library.canonical_source_fact WHERE route=$1 AND collection_id=$2 AND generation=$3 AND basis_digest=$7\n        AND driver=$4 AND (stored_subject_id,fact_id)>($5::uuid,$6::uuid)\n        ORDER BY stored_subject_id,fact_id LIMIT $8',
  oldReferences:
    'SELECT stored_subject_id::text AS "storedSubjectId",fact_id::text AS "factId"\n        FROM library.canonical_source_reference WHERE route=$1 AND collection_id=$2 AND generation=$3\n        AND driver=$4 AND (stored_subject_id,fact_id)>($5::uuid,$6::uuid)\n        ORDER BY stored_subject_id,fact_id LIMIT $7',
  invalidateKey:
    "UPDATE library.identity_scope_plan SET state='invalidated'\n        WHERE route=$1 AND collection_id=$2 AND plan_key=$3",
  invalidateKeyInline:
    "UPDATE library.identity_scope_plan SET state='invalidated' WHERE route=$1 AND collection_id=$2 AND plan_key=$3",
  retainedGenerations:
    'SELECT generation::text,state FROM library.canonical_source_generation WHERE route=$1 AND collection_id=$2 ORDER BY generation LIMIT 2 FOR UPDATE',
  oldHead: 'SELECT generation::text FROM library.canonical_source_head WHERE route=$1 AND collection_id=$2 FOR UPDATE',
  oldState:
    "SELECT jsonb_build_object('readyGeneration',ready_generation,'readyBasis',ready_basis,\n        'workingGeneration',working_generation,'workingBasis',working_basis) AS basis\n       FROM library.canonical_source_state WHERE route=$1 AND collection_id=$2\n         AND (ready_generation IS NOT NULL OR working_generation IS NOT NULL) FOR UPDATE",
  invalidateGeneration:
    "UPDATE library.identity_scope_plan SET state='invalidated'\n      WHERE route=$1 AND collection_id=$2 AND generation=$3 AND state IN ('building','sealed')",
  abandonWorking:
    "UPDATE library.canonical_source_generation SET state='abandoned' WHERE route=$1 AND collection_id=$2 AND state='working'",
  insertGeneration:
    'INSERT INTO library.canonical_source_generation(route,collection_id,generation,basis,driver)\n      VALUES($1,$2,$3,$4::jsonb,$5)',
  insertPlan:
    'INSERT INTO library.identity_scope_plan\n      (route,collection_id,plan_key,account_id,source_identity,job_id,job_epoch,scope,generation,capture_id,capture_frontier,\n       collection_fence,account_fence,job_transaction_id,scope_digest,driver,old_head,old_state,frontier,phase,job_writer_fence)\n      VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15,$16,$17,$18::jsonb,$19::jsonb,$20,$21::jsonb)',
  advanceCapture:
    "UPDATE library.identity_scope_plan SET capture_frontier=$4::jsonb\n        WHERE route=$1 AND collection_id=$2 AND plan_key=$3 AND state='building'",
  mappingClaim:
    'SELECT m.terminal::text,g.published_epoch::text AS epoch,g.pending_job::text,g.pending_epoch::text\n           FROM semantic.identity_epoch_mapping m JOIN semantic.identity_epoch_group g\n            ON (g.partition_no,g.terminal)=(m.control_partition,m.control_group)\n           WHERE m.route=$1 AND m.original=$2 AND g.partition_no=$3 FOR SHARE OF m,g',
  insertEffect:
    'INSERT INTO library.identity_scope_effect\n          (route,collection_id,plan_key,effect_key,disposition,original,operation)\n          VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT DO NOTHING',
  readEffect:
    'SELECT operation FROM library.identity_scope_effect\n            WHERE route=$1 AND collection_id=$2 AND plan_key=$3 AND effect_key=$4 AND disposition=$5',
  insertReference:
    'INSERT INTO library.canonical_source_reference\n        (route,collection_id,generation,canonical_subject_id,stored_subject_id,driver,fact_id)\n        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING',
  advanceGeneration:
    "UPDATE library.canonical_source_generation SET driver=$4,after_subject=$5,after_fact=$6,\n      source_exhausted=$7,version=version+1 WHERE route=$1 AND collection_id=$2 AND generation=$3 AND state='working' AND version=$8 RETURNING generation",
  advancePlan:
    'UPDATE library.identity_scope_plan SET driver=$4,after_subject=$5,after_fact=$6,version=version+1,frontier=$7::jsonb,phase=$8\n      WHERE route=$1 AND collection_id=$2 AND plan_key=$3',
  detachHead:
    'DELETE FROM library.canonical_source_head h\n        WHERE h.route=$1 AND h.collection_id=$2 AND h.generation=$3\n        AND EXISTS(SELECT 1 FROM library.identity_scope_effect e\n          WHERE e.route=$1 AND e.collection_id=$2 AND e.plan_key=$4 LIMIT 1)',
  detachState:
    'UPDATE library.canonical_source_state SET ready_generation=NULL,ready_basis=NULL,\n        working_generation=NULL,working_basis=NULL,after_subject_id=NULL,after_driver=NULL,after_fact_id=NULL,\n        pending_mapping=true,source_exhausted=false WHERE route=$1 AND collection_id=$2\n        AND EXISTS(SELECT 1 FROM library.identity_scope_effect e\n          WHERE e.route=$1 AND e.collection_id=$2 AND e.plan_key=$3 LIMIT 1)',
  insertSeal:
    'INSERT INTO library.identity_scope_seal\n          (route,collection_id,plan_key,generation,version,frontier,capture_frontier,transaction_id)\n          VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8)',
  sealPlan:
    "UPDATE library.identity_scope_plan SET state='sealed',seal_transaction_id=$4\n          WHERE route=$1 AND collection_id=$2 AND plan_key=$3 AND version=$5 AND driver='done' AND state='building'",
  nextPlan:
    "SELECT source_identity,scope FROM library.identity_scope_plan\n        WHERE route=$1 AND job_id=$2 AND job_epoch=$3 AND state='building'\n        ORDER BY collection_id,plan_key LIMIT 1",
  effectPage:
    'SELECT effect_key,disposition,original::text FROM library.identity_scope_effect\n         WHERE route=$1 AND collection_id=$2 AND plan_key=$3\n         AND (effect_key,disposition)>($4::text COLLATE "C",$5::text COLLATE "C")\n         ORDER BY effect_key,disposition LIMIT $6',
} as const);
