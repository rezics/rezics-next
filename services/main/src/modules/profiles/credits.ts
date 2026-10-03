import { profileValidations } from '../../infrastructure/profile.ts';
import { CommandRejected } from '../../infrastructure/fuseki.ts';
import { validatedCommand } from '../../infrastructure/invalid-receipt.ts';
import { AdmissionDenied, AdmissionExpired } from '../access/admission.ts';
import type { MainWorkDependencies } from '../../routes/dependencies.ts';
import { DATASET, GRAPHS, ID, RV, hash, iri, lit, IdempotencyConflict } from '../work/activate.ts';
import { PendingAdmittedWork } from '../work/create-admitted.ts';
import { readWorkEditTerminalReceipt, sealMetadataWorkEditAdmission, workEditReceiptIri } from '../work/edit.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import { fenceWorkBasis, readWorkBasis } from '../work/read-header.ts';
import { pageResult, unerased, WorkReadInvalid, WorkReadMissing, WorkReadMoved, WorkReadUnavailable,
  type WorkReadSession } from '../work/read-session.ts';
import { field, nextPage, pageBasis, publicAgent, readAgent } from './read.ts';

const PROFILE = 'https://rezics.com/definition/native-agent-credit-v1';
const nativeId = /^https:\/\/rezics\.com\/id\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export interface NativeCreditInput { work: string; credit: string; agent: string;
  role: 'author' | 'translator' | 'editor'; expectedWorkHead: string; actingSubject: string }

export function nativeCreditDigest(input: NativeCreditInput) {
  if (![input.work, input.credit, input.agent, input.expectedWorkHead, input.actingSubject].every(id => nativeId.test(id))
    || !['author', 'translator', 'editor'].includes(input.role)) throw new WorkReadInvalid('Invalid native Agent credit');
  return hash(JSON.stringify({ profile: 'native-agent-credit-v1', work: input.work, credit: input.credit,
    agent: input.agent, role: input.role, expectedWorkHead: input.expectedWorkHead, actingSubject: input.actingSubject }));
}

/** Work-edit authority makes an attribution assertion, not an Agent ownership
 * claim. One exact Work/Agent/role tuple; no source-reference conversion.
 * At most 16 graph/health calls including terminal reconciliation; each command
 * has a ten-second deadline. No relation is materialized. Duplicate detection
 * may inspect the Work/Agent degree in Jena; it is not a measured seek bound. */
export async function createNativeCredit(deps: MainWorkDependencies, request: Request,
  input: NativeCreditInput, key: string) {
  const digest = nativeCreditDigest(input);
  const env = deps.environment;
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const principal = await deps.account.verify(request, ['work:edit']);
  const registered = await deps.access.register({ principal, actingSubject: input.actingSubject,
    scope: `work:edit:${input.work}`, action: 'work.edit', idempotencyKey: key, requestDigest: digest });
  let admission = registered;
  if (registered.state !== 'sealed' && registered.dispatchEligible) {
    // A baseline member's own-Work admission is claimed only with the current Account assertion.
    try { admission = await deps.access.claim(registered.id, digest, principal); }
    catch (error) { if (!(error instanceof AdmissionDenied || error instanceof AdmissionExpired)) throw error; }
  }
  const receipt = workEditReceiptIri(admission.id);
  const revision = `${ID}${admission.id}`;
  if (admission.state !== 'sealed' && !await readWorkEditTerminalReceipt(env, admission.id)) {
    if (!admission.dispatchEligible || admission.state === 'registered') {
      await sealMetadataWorkEditAdmission(env, admission);
    } else {
      if (!deps.profiles || !await deps.profiles.agentFence(input.agent)) {
        await sealMetadataWorkEditAdmission(env, admission);
        throw new WorkReadMissing('Agent unavailable');
      }
      const common = `rv:work ${iri(input.work)} ; rv:agent ${iri(input.agent)} ; schema:roleName ${lit(input.role)}`;
      const validations = await profileValidations(env.fuseki, 'native-agent-credit-v1', [
        { shape: `${PROFILE}/credit-shape`, focus: [input.credit], graphs: [GRAPHS.current, GRAPHS.revisions] },
        { shape: `${PROFILE}/revision-shape`, focus: [revision], graphs: [GRAPHS.current, GRAPHS.revisions] },
      ]);
      const event = `urn:rezics:event:${hash(`${receipt}\0native-credit`)}`;
      const update = `PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
        PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
        DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n } }
        INSERT { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
          GRAPH ${iri(GRAPHS.current)} { ${iri(input.credit)} a rv:NativeAgentCredit ;
            rv:creditRevision ${iri(revision)} ; ${common} . }
          GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} a rv:NativeAgentCreditRevision, rv:RevisionAnchor ;
            rv:component ${iri(input.credit)} ; ${common} ; rv:workRevision ${iri(input.expectedWorkHead)} ;
            rv:modelRevision ${iri(PROFILE)} ; rv:shapeRevision ${iri(PROFILE)} ;
            rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next . }
          GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ;
            rv:requestDigest ${lit(digest)} ; rv:admissionId ${lit(admission.id)} ;
            rv:authorityEpoch ${lit(admission.authorityEpoch)} ; rv:admittedScope ${lit(admission.scope)} ;
            rv:outcome rv:Succeeded ; rv:work ${iri(input.work)} ; rv:workRevision ${iri(input.expectedWorkHead)} ;
            rv:expectedHead ${iri(input.expectedWorkHead)} ; rv:nativeCredit ${iri(input.credit)} ;
            rv:creditRevision ${iri(revision)} ; rv:datasetId ${iri(DATASET)} ;
            rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next . }
          GRAPH ${iri(GRAPHS.outbox)} { ${iri(`urn:rezics:outbox:${hash(receipt)}`)} a rv:OutboxBatch ;
            rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next ; rv:eventCount 1 ; rv:event ${iri(event)} .
            ${iri(event)} a rv:NativeAgentCreditCreatedEvent ; rv:ordinal 0 ; rv:action "work.edit" ;
              rv:receipt ${iri(receipt)} ; rv:work ${iri(input.work)} . } }
        WHERE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
            rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
          GRAPH ${iri(GRAPHS.current)} { ${iri(input.work)} a schema:CreativeWork ; rv:head ${iri(input.expectedWorkHead)} . }
          ${publicAgent(iri(input.agent))}
          ${unerased(iri(input.work))}
          FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(input.agent)} rv:profileDisclosure rv:Private } }
          FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(input.credit)} ?p ?o } }
          FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ?duplicate a rv:NativeAgentCredit ; ${common} } }
          FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} ?p ?o } }
          FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
          FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
          BIND(?n + 1 AS ?next) }`;
      try {
        const result = await validatedCommand(env, { receipt, digest, update, validations, deadlineMs: 10_000 }, admission);
        if (result.status === 'invalid' || result.status === 'unknown-profile') throw new CommandRejected(result);
        if (result.status === 'guard-unmatched') await sealMetadataWorkEditAdmission(env, admission);
      } catch (error) { if (error instanceof CommandRejected) throw error; /* receipt resolves a lost response */ }
    }
  }
  const terminal = await readWorkEditTerminalReceipt(env, admission.id);
  if (!terminal) throw new PendingAdmittedWork(admission.id, 'work-edit');
  await deps.access.recordGraphOutcome(admission.id, terminal);
  if (terminal.requestDigest !== digest || terminal.scope !== admission.scope || terminal.authorityEpoch !== admission.authorityEpoch) {
    throw new IdempotencyConflict('Credit receipt differs');
  }
  if (terminal.outcome !== 'succeeded') throw new WorkReadMoved('Credit target, Work head or attribution changed');
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?credit ?revision WHERE {
    GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} rv:nativeCredit ?credit ; rv:creditRevision ?revision } } LIMIT 2`, 8192)).results?.bindings ?? [];
  if (rows.length !== 1 || rows[0]?.credit?.value !== input.credit || rows[0]?.revision?.value !== revision) {
    throw new WorkReadUnavailable('Credit receipt is incomplete');
  }
  return { profile: 'native-agent-credit-v1' as const, credit: input.credit, revision,
    work: input.work, agent: input.agent, role: input.role, replayed: registered.replayed,
    sourcePosition: { dataEpoch: terminal.dataEpoch, sequence: terminal.sequence } };
}

export async function readNativeCredits(session: WorkReadSession, work: string) {
  const workBasis = await readWorkBasis(session, work);
  const { limit, binding, after } = pageBasis(session, 'native-credits', [work, session.principal]);
  const rows = await session.query(`SELECT ?id ?agent ?role WHERE {
    GRAPH ${iri(GRAPHS.current)} { ?id a rv:NativeAgentCredit ; rv:work ${iri(work)} ;
      rv:agent ?agent ; schema:roleName ?role ; rv:creditRevision ?revision . }
    GRAPH ${iri(GRAPHS.revisions)} { ?revision a rv:NativeAgentCreditRevision ; rv:component ?id ;
      rv:work ${iri(work)} ; rv:agent ?agent ; schema:roleName ?role .
      FILTER NOT EXISTS { ?revision a rv:ErasedRevision } }
    ${publicAgent('?agent')} FILTER(STR(?id) > ${lit(after)})
  } ORDER BY STR(?id) LIMIT ${limit + 1}`, limit + 1);
  const items = [];
  for (const row of rows.slice(0, limit)) {
    const role = field(row, 'role');
    if (!['author', 'translator', 'editor'].includes(role)) throw new WorkReadUnavailable('Invalid credit role');
    try {
      const agent = await readAgent(session, field(row, 'agent'));
      items.push({ id: field(row, 'id'), role: role as NativeCreditInput['role'],
        agent: agent.id, displayName: agent.displayName, handle: agent.handle, address: agent.address });
    } catch (error) { if (!(error instanceof WorkReadMissing)) throw error; }
  }
  await fenceWorkBasis(session, workBasis);
  for (const item of items) await readAgent(session, item.agent);
  return pageResult(session, items, nextPage(session, binding, rows.map(row => field(row, 'id')), limit));
}
