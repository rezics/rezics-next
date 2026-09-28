import type { Pool } from 'pg';
import type { WorkActivationEnvironment } from '../work/activate.ts';
import { DATASET, GRAPHS, RV, hash, iri, lit, workMetadataValidations } from '../work/activate.ts';
import { profileValidations } from '../../infrastructure/profile.ts';
import { reconciledCursor, RetainedEffectConflict } from '../work/reconcile-restored.ts';
import { relayRetainedEventAt, type RelayCoverage } from '../outbox/relay.ts';
import { protectionReceiptIri, workReceiptFamilies,
  type WorkProtectionAdmissionAction } from './receipt-family.ts';
import { signProtectionAdmission } from '../access/protection-admission.ts';
import { readWorkProtectionReceipt, workProtectionDigest,
  type WorkEditorialBasis, type WorkCorrectionProposal, type WorkCorrectionReview,
  type WorkProtectionChange } from './work.ts';
import type { RecoveryTerm, RecoveryTriple } from './recovery-evidence.ts';

const markerFor = (epoch: string) => `urn:rezics:restore:${epoch}`;
const safeIri = (value: string) => {
  if (!/^(?:https?:\/\/[^<>\s"{}|\\^`]+|urn:rezics:[A-Za-z0-9:._-]+)$/.test(value)) {
    throw new RetainedEffectConflict('retained Work protection term is invalid');
  }
  return `<${value}>`;
};
function term(value: RecoveryTerm): string {
  if (value.type === 'uri' && !value.datatype && !value['xml:lang']) return safeIri(value.value);
  if (value.type !== 'literal' && value.type !== 'typed-literal') {
    throw new RetainedEffectConflict('retained Work protection term is invalid');
  }
  if (value.datatype && value['xml:lang']) throw new RetainedEffectConflict('ambiguous retained literal');
  if (value['xml:lang'] && !/^[A-Za-z]{1,8}(?:-[A-Za-z0-9]{1,8})*$/.test(value['xml:lang'])) {
    throw new RetainedEffectConflict('retained Work protection language is invalid');
  }
  return `${lit(value.value)}${value.datatype ? `^^${safeIri(value.datatype)}`
    : value['xml:lang'] ? `@${value['xml:lang']}` : ''}`;
}
function value(triples: RecoveryTriple[], graph: string, subject: string, predicate: string): string | null {
  const matches = triples.filter(row => row.graph === graph && row.subject === subject
    && row.predicate === `${RV}${predicate}`);
  if (matches.length > 1) throw new RetainedEffectConflict('ambiguous retained Work protection value');
  return matches[0]?.object.value ?? null;
}
function exact(triples: RecoveryTriple[], graph: string, subject: string,
  predicate: string, expected: string): void {
  if (value(triples, graph, subject, predicate) !== expected) {
    throw new RetainedEffectConflict(`retained Work protection ${predicate} differs`);
  }
}
function subjectTriples(triples: RecoveryTriple[], graph: string): string {
  return triples.filter(row => row.graph === graph)
    .map(row => `${safeIri(row.subject)} ${safeIri(row.predicate)} ${term(row.object)} .`).join('\n');
}
type Intent = WorkEditorialBasis & {
  action: WorkProtectionAdmissionAction; operation: string; proposal?: string; candidate?: string;
  decision?: string; control?: string | null; application?: string | null; title?: string;
  predecessor?: string | null; proposalRevision?: string; candidateDigest?: string;
  expectedDecisionHead?: null; outcome?: 'approved' | 'rejected';
};

/** Reapply one exact retained graph effect while the old writer and Access admission remain fenced.
 * Three named-graph subject groups, one sealed Access row, one Work and one replay cursor
 * bound the work regardless of unrelated graph size. No external delivery is performed. */
export async function reconcileRetainedWorkProtection(env: WorkActivationEnvironment,
  accessPool: Pool, relayPool: Pool, coverage: RelayCoverage, sequence: string,
): Promise<{ receipt: string; replayed: boolean }> {
  if (!/^[1-9][0-9]*$/.test(sequence) || BigInt(sequence) > BigInt(coverage.sequence)) {
    throw new RetainedEffectConflict('invalid retained Work protection position');
  }
  const retained = await relayRetainedEventAt(relayPool, coverage, sequence);
  const envelope = retained.envelope as unknown as { id: string; specversion: string; source: string;
    data: { sourcePosition: { dataEpoch: string; sequence: string }; ordinal: number;
      batchId: string; routingEpoch: string;
    recovery?: RecoveryTriple[]; receipt: { id: string; action: WorkProtectionAdmissionAction;
      outcome: string; admissionId: string; requestDigest: string; authorityEpoch: string;
      scope: string; operation?: string; work?: string } } };
  const effect = envelope.data?.receipt;
  const triples = envelope.data?.recovery;
  if (envelope.id !== retained.eventId || envelope.specversion !== '1.0'
    || envelope.source !== 'https://rezics.com/services/main'
    || envelope.data.sourcePosition.dataEpoch !== coverage.dataEpoch
    || envelope.data.sourcePosition.sequence !== sequence || envelope.data.ordinal !== 0
    || !effect || effect.outcome !== 'succeeded' || !Object.hasOwn(workReceiptFamilies, effect.action)
    || !effect.operation || !effect.work || !Array.isArray(triples)
    || triples.length < 8 || triples.length > 192
    || effect.id !== protectionReceiptIri(effect.admissionId, effect.action)
    || retained.batch.batchId !== envelope.data.batchId || retained.batch.eventCount !== 1
    || retained.batch.routingEpoch !== envelope.data.routingEpoch
    || retained.eventId !== `urn:rezics:event:${hash(effect.id)}`
    || envelope.data.batchId !== `urn:rezics:outbox:${hash(effect.id)}`) {
    throw new RetainedEffectConflict('retained Work protection effect differs');
  }
  const revisionSubjects = new Set<string>();
  const allowed = new Map<string, Set<string>>([[GRAPHS.receipts, new Set([effect.id])],
    [GRAPHS.outbox, new Set([envelope.data.batchId, retained.eventId])]]);
  for (const row of triples) {
    if (!row || typeof row.graph !== 'string' || typeof row.subject !== 'string'
      || typeof row.predicate !== 'string' || !row.object
      || typeof row.object.value !== 'string') throw new RetainedEffectConflict('invalid recovery triple');
    safeIri(row.subject); safeIri(row.predicate); term(row.object);
    if (row.graph === GRAPHS.revisions) revisionSubjects.add(row.subject);
    else if (!allowed.get(row.graph)?.has(row.subject)) {
      throw new RetainedEffectConflict('retained Work protection graph or subject differs');
    }
  }
  if (revisionSubjects.size < 1 || revisionSubjects.size > 4
    || !triples.some(row => row.graph === GRAPHS.receipts && row.subject === effect.id)
    || !triples.some(row => row.graph === GRAPHS.outbox && row.subject === retained.eventId)) {
    throw new RetainedEffectConflict('retained Work protection subjects are incomplete');
  }
  for (const subject of revisionSubjects) {
    exact(triples, GRAPHS.revisions, subject, 'operation', effect.operation);
    exact(triples, GRAPHS.revisions, subject, 'dataEpoch', coverage.dataEpoch);
    exact(triples, GRAPHS.revisions, subject, 'sequence', sequence);
  }
  for (const [predicate, expected] of Object.entries({ action: effect.action,
    admissionId: effect.admissionId, requestDigest: effect.requestDigest,
    authorityEpoch: effect.authorityEpoch, admittedScope: effect.scope,
    dataEpoch: coverage.dataEpoch, sequence })) {
    exact(triples, GRAPHS.receipts, effect.id, predicate, expected);
  }
  const intentPredicate = effect.action.startsWith('work.protection.') ? 'protectionIntent'
    : effect.action === 'work.correction.propose' ? 'proposalIntent' : 'decisionIntent';
  const intentRows = triples.filter(row => row.graph === GRAPHS.revisions
    && row.predicate === `${RV}${intentPredicate}`);
  if (intentRows.length !== 1) throw new RetainedEffectConflict('retained Work protection intent is missing');
  let intent: Intent;
  try { intent = JSON.parse(intentRows[0]!.object.value) as Intent; }
  catch { throw new RetainedEffectConflict('retained Work protection intent is invalid'); }
  const profile = effect.action.startsWith('work.protection.') ? 'work-title-protection-v1'
    : effect.action === 'work.correction.propose' ? 'work-title-correction-v1'
      : 'work-title-correction-review-v1';
  const basis: WorkEditorialBasis = { work: intent.work, expectedHead: intent.expectedHead,
    expectedProtection: intent.expectedProtection, expectedControl: intent.expectedControl,
    expectedControlEpoch: intent.expectedControlEpoch, expectedRuleRevision: intent.expectedRuleRevision,
    actingSubject: intent.actingSubject, reason: intent.reason, evidence: intent.evidence,
    idempotencyKey: intent.idempotencyKey };
  const request = effect.action.startsWith('work.protection.')
    ? { ...basis, action: effect.action.slice('work.protection.'.length) } as WorkProtectionChange
    : effect.action === 'work.correction.propose'
      ? { ...basis, title: intent.title!, predecessor: intent.predecessor ?? null } as WorkCorrectionProposal
      : { ...basis, proposalRevision: intent.proposalRevision!,
        candidateDigest: intent.candidateDigest!, expectedDecisionHead: null,
        outcome: intent.outcome! } as WorkCorrectionReview;
  if (intent.action !== effect.action || intent.operation !== effect.operation
    || intent.work !== effect.work || effect.scope !== `${effect.action.startsWith('work.protection.')
      ? 'work:protect:' : effect.action === 'work.correction.propose' ? 'work:correct:' : 'work:review:'}${intent.work}`
    || workProtectionDigest(profile, request) !== effect.requestDigest) {
    throw new RetainedEffectConflict('retained Work protection digest differs');
  }
  const client = await accessPool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    const fence = (await client.query<{ open: boolean }>(
      'SELECT open FROM access.recovery_fence WHERE id = true FOR SHARE')).rows[0];
    const row = (await client.query<{ action: string; state: string; scope_id: string;
      request_digest: string; authority_epoch: string; graph_receipt: string;
      graph_outcome: string; graph_data_epoch: string; graph_sequence: string;
      acting_subject: string; idempotency_key: string }>(
      'SELECT * FROM access.admission WHERE id = $1', [effect.admissionId])).rows[0];
    if (fence?.open !== false || !row || row.state !== 'sealed' || row.action !== effect.action
      || row.scope_id !== effect.scope || row.request_digest !== effect.requestDigest
      || row.authority_epoch !== effect.authorityEpoch || row.graph_receipt !== effect.id
      || row.graph_outcome !== 'succeeded' || row.graph_data_epoch !== coverage.dataEpoch
      || row.graph_sequence !== sequence || row.acting_subject !== intent.actingSubject
      || row.idempotency_key !== intent.idempotencyKey) {
      throw new RetainedEffectConflict('Access does not prove retained Work protection effect');
    }
    const marker = markerFor(env.lineage.dataEpoch);
    const prior = await readWorkProtectionReceipt(env, effect.admissionId, effect.action);
    if (!prior) {
      const base = `GRAPH ${iri(GRAPHS.current)} { ${iri(intent.work)} rv:head ${iri(intent.expectedHead)} ;
        <http://www.w3.org/2000/01/rdf-schema#label> ?oldTitle .
        OPTIONAL { ${iri(intent.work)} rv:protectionHead ?oldProtection }
        OPTIONAL { ${iri(intent.work)} rv:titleControlHead ?oldControl } }
        FILTER(${intent.expectedProtection ? `?oldProtection = ${iri(intent.expectedProtection)}` : '!BOUND(?oldProtection)'})
        FILTER(${intent.expectedControl ? `?oldControl = ${iri(intent.expectedControl)}` : '!BOUND(?oldControl)'})`;
      let deleteCurrent = '', insertCurrent = '', extraGuard = '';
      if (effect.action.startsWith('work.protection.')) {
        const protection = value(triples, GRAPHS.receipts, effect.id, 'protectionRevision');
        if (!protection || !revisionSubjects.has(protection)) throw new RetainedEffectConflict('protection revision is absent');
        deleteCurrent = `${iri(intent.work)} rv:protectionHead ?oldProtection .`;
        insertCurrent = `${iri(intent.work)} rv:protectionHead ${iri(protection)} .`;
        if (intent.action === 'work.protection.confirm') {
          const control = value(triples, GRAPHS.receipts, effect.id, 'titleControl');
          if (!control || !revisionSubjects.has(control)) throw new RetainedEffectConflict('control revision is absent');
          deleteCurrent += `${iri(intent.work)} rv:titleControlHead ?oldControl .`;
          insertCurrent += `${iri(intent.work)} rv:titleControlHead ${iri(control)} .`;
        }
      } else if (effect.action === 'work.correction.propose') {
        const proposal = value(triples, GRAPHS.receipts, effect.id, 'proposalRevision');
        if (!proposal || !revisionSubjects.has(proposal)) throw new RetainedEffectConflict('proposal revision is absent');
        const log = `urn:rezics:correction-log:${hash(`${intent.work}\0title:en`)}`;
        const ordinal = value(triples, GRAPHS.revisions, proposal, 'logOrdinal');
        const previous = value(triples, GRAPHS.revisions, proposal, 'logPredecessor');
        if (!ordinal || !/^[1-9][0-9]*$/.test(ordinal)) throw new RetainedEffectConflict('proposal ordinal is invalid');
        deleteCurrent = `${iri(log)} rv:proposalHead ?oldLogHead ; rv:proposalCount ?oldLogCount .`;
        insertCurrent = `${iri(log)} a rv:CorrectionLog ; rv:component ${iri(intent.work)} ;
          rv:protectedSlot "title:en" ; rv:adoptionContext rv:GlobalNative ;
          rv:proposalHead ${iri(proposal)} ; rv:proposalCount ${ordinal} .`;
        extraGuard = `OPTIONAL { GRAPH ${iri(GRAPHS.current)} {
          ${iri(log)} rv:proposalHead ?oldLogHead ; rv:proposalCount ?oldLogCount . } }
          FILTER(${previous ? `?oldLogHead = ${iri(previous)} && ?oldLogCount = ${BigInt(ordinal) - 1n}`
            : '!BOUND(?oldLogHead) && !BOUND(?oldLogCount)'})`;
      } else {
        const decision = value(triples, GRAPHS.receipts, effect.id, 'decision');
        const proposal = value(triples, GRAPHS.receipts, effect.id, 'proposalRevision');
        const outcome = value(triples, GRAPHS.receipts, effect.id, 'reviewOutcome');
        if (!decision || !proposal || !revisionSubjects.has(decision)
          || !['approved', 'rejected'].includes(intent.outcome ?? '')
          || outcome !== `${RV}${intent.outcome === 'approved' ? 'Accepted' : 'Rejected'}`) {
          throw new RetainedEffectConflict('retained review decision differs');
        }
        extraGuard = `GRAPH ${iri(GRAPHS.revisions)} { ${iri(proposal)} a rv:CorrectionProposal ;
          rv:component ${iri(intent.work)} ; rv:baseRevision ${iri(intent.expectedHead)} ;
          rv:candidateRevision ?candidate ; rv:candidateDigest ${lit(intent.candidateDigest!)} . }
          FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ${iri(decision)} ?p ?o } }`;
        if (intent.outcome === 'approved') {
          const revision = value(triples, GRAPHS.receipts, effect.id, 'workRevision');
          const control = value(triples, GRAPHS.receipts, effect.id, 'titleControl');
          if (!revision || !control || !revisionSubjects.has(control)) {
            throw new RetainedEffectConflict('retained approved correction is incomplete');
          }
          extraGuard += ` FILTER(?candidate = ${iri(revision)})`;
          deleteCurrent = `${iri(intent.work)} rv:head ${iri(intent.expectedHead)} ;
            <http://www.w3.org/2000/01/rdf-schema#label> ?oldTitle ; rv:titleControlHead ?oldControl .`;
          insertCurrent = `${iri(intent.work)} rv:head ${iri(revision)} ;
            <http://www.w3.org/2000/01/rdf-schema#label> ${lit(intent.title!)}@en ;
            rv:titleControlHead ${iri(control)} .`;
        }
      }
      const update = `PREFIX rv: <${RV}> DELETE { GRAPH ${iri(GRAPHS.control)} {
        ${iri(marker)} rv:reconciledPriorSequence ?last . }
        GRAPH ${iri(GRAPHS.current)} { ${deleteCurrent} } }
        INSERT { GRAPH ${iri(GRAPHS.control)} { ${iri(marker)} rv:reconciledPriorSequence ${sequence} . }
          GRAPH ${iri(GRAPHS.current)} { ${insertCurrent} }
          GRAPH ${iri(GRAPHS.revisions)} { ${subjectTriples(triples, GRAPHS.revisions)} }
          GRAPH ${iri(GRAPHS.receipts)} { ${subjectTriples(triples, GRAPHS.receipts)} }
          GRAPH ${iri(GRAPHS.outbox)} { ${subjectTriples(triples, GRAPHS.outbox)} } }
        WHERE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
          rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence 0 ;
          rv:restoreCutover ${iri(marker)} ; rv:restoreHold true .
          ${iri(marker)} rv:priorDataEpoch ${lit(coverage.dataEpoch)} ; rv:priorSequence ?saved .
          OPTIONAL { ${iri(marker)} rv:reconciledPriorSequence ?last }
          BIND(COALESCE(?last, ?saved) AS ?previous) FILTER(?previous + 1 = ${sequence}) }
          ${base} ${extraGuard}
          FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(effect.id)} ?p ?o } }
          FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.outbox)} { ${iri(envelope.data.batchId)} ?p ?o } }
        }`;
      const protectionProfile = 'https://rezics.com/definition/protection-revision-v1';
      const proposalProfile = 'https://rezics.com/definition/correction-proposal-v1';
      const decisionProfile = 'https://rezics.com/definition/correction-decision-v1';
      const controlProfile = 'https://rezics.com/definition/work-title-control-v1';
      let validations;
      if (effect.action.startsWith('work.protection.')) {
        const protection = value(triples, GRAPHS.receipts, effect.id, 'protectionRevision')!;
        validations = await profileValidations(env.fuseki, 'protection-revision-v1', [
          { shape: `${protectionProfile}/target-shape`, focus: [intent.work],
            graphs: [GRAPHS.current, GRAPHS.revisions] },
          { shape: `${protectionProfile}/protection-shape`, focus: [protection],
            graphs: [GRAPHS.current, GRAPHS.revisions] },
        ]);
      } else if (effect.action === 'work.correction.propose') {
        const proposal = value(triples, GRAPHS.receipts, effect.id, 'proposalRevision')!;
        const log = `urn:rezics:correction-log:${hash(`${intent.work}\0title:en`)}`;
        validations = await profileValidations(env.fuseki, 'correction-proposal-v1', [
          { shape: `${proposalProfile}/log-shape`, focus: [log],
            graphs: [GRAPHS.current, GRAPHS.revisions] },
          { shape: `${proposalProfile}/proposal-shape`, focus: [proposal],
            graphs: [GRAPHS.current, GRAPHS.revisions] },
        ]);
      } else {
        const decision = value(triples, GRAPHS.receipts, effect.id, 'decision')!;
        validations = await profileValidations(env.fuseki, 'correction-decision-v1', [
          { shape: `${decisionProfile}/decision-shape`, focus: [decision],
            graphs: [GRAPHS.current, GRAPHS.revisions] },
          ...(intent.outcome === 'approved' ? [{ shape: `${decisionProfile}/application-shape`,
            focus: [`urn:rezics:correction-application:${hash(intent.proposalRevision!)}`],
            graphs: [GRAPHS.current, GRAPHS.revisions] }] : []),
        ]);
      }
      const control = value(triples, GRAPHS.receipts, effect.id, 'titleControl');
      if (control) validations.push(...await profileValidations(env.fuseki, 'work-title-control-v1', [
        { shape: `${controlProfile}/control-shape`, focus: [control],
          graphs: [GRAPHS.current, GRAPHS.revisions] },
      ]));
      if (effect.action === 'work.correction.review' && intent.outcome === 'approved') {
        const main = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?main WHERE {
          GRAPH ${iri(GRAPHS.current)} { ${iri(intent.work)} rv:mainVersion ?main . }
        } LIMIT 2`, 2048)).results?.bindings ?? [];
        if (main.length !== 1 || !main[0]?.main) throw new RetainedEffectConflict('Work main version is absent');
        validations.push(...await workMetadataValidations(env, intent.work, main[0].main.value));
      }
      const command = { receipt: effect.id,
        digest: effect.requestDigest, update, validations, deadlineMs: 10_000 };
      const proposerAdmission = effect.action === 'work.correction.review'
        ? (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?admission WHERE {
          GRAPH ${iri(GRAPHS.revisions)} { ${iri(intent.proposalRevision!)}
            rv:proposalAdmission ?admission . } } LIMIT 2`, 2048)).results?.bindings[0]?.admission?.value ?? null
        : null;
      if (effect.action === 'work.correction.review' && !proposerAdmission) {
        throw new RetainedEffectConflict('retained proposer admission is absent');
      }
      const result = await env.fuseki.commandWithReceipt({ ...command,
        titleAdmission: signProtectionAdmission({ id: effect.admissionId,
          action: effect.action, scope: effect.scope, authorityEpoch: effect.authorityEpoch },
        command, new Date(Date.now() + 10_000).toISOString(), proposerAdmission,
        env.titleAdmissionKey) });
      if (result.status !== 'committed') throw new RetainedEffectConflict(
        `retained Work protection command ${result.status}${result.status === 'invalid'
          ? `: ${JSON.stringify(result.report ?? null).slice(0, 1200)}` : ''}`);
    }
    const actual = await readWorkProtectionReceipt(env, effect.admissionId, effect.action);
    const cursor = await reconciledCursor(env, marker);
    if (!actual || actual.receipt !== effect.id || actual.action !== effect.action
      || actual.outcome !== 'succeeded' || actual.admissionId !== effect.admissionId
      || actual.scope !== effect.scope || actual.authorityEpoch !== effect.authorityEpoch
      || actual.work !== effect.work || actual.operation !== effect.operation
      || actual.requestDigest !== effect.requestDigest
      || actual.dataEpoch !== coverage.dataEpoch || actual.sequence !== sequence
      || cursor === null || cursor < BigInt(sequence)) {
      throw new RetainedEffectConflict('Work protection receipt or recovery frontier differs');
    }
    await client.query('COMMIT');
    return { receipt: effect.id, replayed: !!prior };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* preserve original error */ }
    throw error;
  } finally { client.release(); }
}
