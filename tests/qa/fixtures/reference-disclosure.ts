import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { WorkActivationEnvironment } from '../../../services/main/src/modules/work/activate.ts';
import { GRAPHS, iri, lit } from '../../../services/main/src/modules/work/activate.ts';

/** Retained owner-state counterexamples for scalar/page disclosure parity.
 * The receipts and Access certificates are deliberately independent of grants. */
export async function referenceDisclosureFixture(
  pool: Pool,
  env: WorkActivationEnvironment,
  principal: string,
  actor: string,
) {
  const native = () => `https://rezics.com/id/${randomUUID()}`;
  const refs = {
    publicWork: native(),
    publicSemantic: native(),
    definition: native(),
    zone: native(),
    space: native(),
    ambiguousSpace: native(),
    collection: native(),
    protectedCollection: native(),
    authoredWork: native(),
    protectedDefinition: native(),
    granted: native(),
    workGranted: native(),
    hidden: native(),
    missing: native(),
  };
  const control = randomUUID();
  await pool.query(
    `INSERT INTO access.representation (id,principal_id,subject_id,action,valid_until)
    VALUES ($1,$2,$3,'agent.control','infinity')`,
    [control, principal, actor],
  );
  await pool.query(
    `INSERT INTO access.agent_provision (id,principal_id,idempotency_key,request_digest,
    agent_id,agent_kind,display_name,principal_epoch,state,graph_data_epoch,graph_sequence,representation_id)
    VALUES ($1::uuid,$2,$1::text,$3,$4,'person','Disclosure member',0,'active',$5,0,$6)`,
    [randomUUID(), principal, '0'.repeat(64), actor, env.lineage.dataEpoch, control],
  );
  await pool.query(
    `INSERT INTO access.platform_administrator
    (principal_id,role,receipt,request_digest,idempotency_key)
    VALUES ($1,'platform.administrator',$2,$3,'platform-first-administrator-v1')`,
    [principal, `urn:rezics:access-receipt:${'a'.repeat(64)}`, 'a'.repeat(64)],
  );
  const current: string[] = [],
    revisions: string[] = [],
    receipts: string[] = [];
  const certificate = async (action: string, scope: string) => {
    const admission = randomUUID(),
      digest = createHash('sha256').update(admission).digest('hex');
    const receipt = `urn:rezics:receipt:${digest}`;
    await pool.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING', [
      scope,
    ]);
    await pool.query(
      `INSERT INTO access.admission (id,principal_id,acting_subject,scope_id,action,
      idempotency_key,request_digest,authority_epoch,expires_at,state,graph_receipt,graph_outcome,
      graph_data_epoch,graph_sequence,sealed_at)
      VALUES ($1::uuid,$2,$3,$4,$5,$1::text,$6,0,'infinity','sealed',$7,'succeeded',$8,'0',now())`,
      [admission, principal, actor, scope, action, digest, receipt, env.lineage.dataEpoch],
    );
    return { admission, digest, receipt };
  };
  const definition = async (resource: string, protectedHead = false) => {
    const revision = native(),
      proof = await certificate('semantic.change', 'semantic:create:root');
    current.push(`${iri(resource)} a rv:SemanticDefinition ; rv:definitionHead ${iri(revision)}
      ${protectedHead ? `; rv:protectionHead ${iri(native())}` : ''} .`);
    revisions.push(
      `${iri(revision)} a rv:DefinitionRevision ; rv:component ${iri(resource)} ; rv:lifecycle rv:Active .`,
    );
    receipts.push(`${iri(proof.receipt)} rv:component ${iri(resource)} ; rv:revision ${iri(revision)} ;
      rv:admittedScope "semantic:create:root" ; rv:admissionId ${lit(proof.admission)} ;
      rv:requestDigest ${lit(proof.digest)} ; rv:outcome rv:Succeeded .`);
  };
  await definition(refs.definition);
  await definition(refs.protectedDefinition, true);
  const zone = async (space: string, resource: string, ambiguous = false) => {
    const proof = await certificate('space.create', 'space:create:root');
    current.push(`${iri(space)} a rv:Space ; rv:owner ${iri(actor)} ; rv:zoneCapability ${iri(resource)} .
      ${iri(resource)} a rv:Zone ; rv:space ${iri(space)} .`);
    const body = `a rv:OperationReceipt ; rv:outcome rv:Succeeded ; rv:admittedScope "space:create:root" ;
      rv:space ${iri(space)} ; rv:zone ${iri(resource)} ; rv:owner ${iri(actor)} ;
      rv:admissionId ${lit(proof.admission)} ; rv:requestDigest ${lit(proof.digest)} .`;
    receipts.push(`${iri(proof.receipt)} ${body}`);
    if (ambiguous) receipts.push(`${iri(`urn:rezics:receipt:${'b'.repeat(64)}`)} ${body}`);
  };
  await zone(refs.space, refs.zone);
  await zone(refs.ambiguousSpace, native(), true);
  current.push(
    `${iri(refs.collection)} a rv:Collection ; rv:curator ${iri(actor)} ; rv:collectionState rv:Active .`,
    `${iri(refs.protectedCollection)} a rv:DynamicCollection ; rv:curator ${iri(actor)} ;
      rv:collectionState rv:Active ; rv:protectionHead ${iri(native())} .`,
  );
  const publicMain = native();
  current.push(`${iri(refs.publicWork)} a schema:CreativeWork ; rv:mainVersion ${iri(publicMain)} ;
    rv:head ${iri(native())} ; rv:catalogueVisible true .
    ${iri(publicMain)} a rv:MainVersion ; rv:work ${iri(refs.publicWork)} .`);
  const semanticHead = native();
  current.push(
    `${iri(refs.publicSemantic)} rv:semanticHead ${iri(semanticHead)} ; rv:semanticWork ${iri(refs.publicWork)} .`,
  );
  revisions.push(`${iri(semanticHead)} a rv:SemanticRevision, rv:RevisionAnchor ;
    rv:component ${iri(refs.publicSemantic)} ; rv:lifecycle rv:Active ; rv:sequence 1 .`);
  const authoredMain = native(),
    author = await certificate('work.create', 'work:create:root');
  current.push(`${iri(refs.authoredWork)} a schema:CreativeWork ; rv:head ${iri(native())} ;
    rv:mainVersion ${iri(authoredMain)} . ${iri(authoredMain)} a rv:MainVersion ; rv:work ${iri(refs.authoredWork)} .`);
  receipts.push(`${iri(author.receipt)} rv:work ${iri(refs.authoredWork)} ; rv:mainVersion ${iri(authoredMain)} ;
    rv:admissionId ${lit(author.admission)} ; rv:requestDigest ${lit(author.digest)} ;
    rv:admittedScope "work:create:root" ; rv:outcome rv:Succeeded .`);
  await pool.query(
    `INSERT INTO access.work_maintainer_set (work,main_version,creation_admission)
    VALUES ($1,$2,$3)`,
    [refs.authoredWork, authoredMain, author.admission],
  );
  await pool.query('INSERT INTO access.work_maintainer (work,agent) VALUES ($1,$2)', [
    refs.authoredWork,
    actor,
  ]);
  current.push(`${iri(refs.hidden)} a rv:SemanticResource .`);
  await env.fuseki
    .update(`PREFIX rv: <https://rezics.com/vocab/> PREFIX schema: <https://schema.org/>
    INSERT DATA { GRAPH ${iri(GRAPHS.current)} { ${current.join('\n')} }
      GRAPH ${iri(GRAPHS.revisions)} { ${revisions.join('\n')} }
      GRAPH ${iri(GRAPHS.receipts)} { ${receipts.join('\n')} } }`);
  return { refs, control };
}
