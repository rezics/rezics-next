import { CommandRejected, fusekiReadBudget, FusekiReadBudgetExceeded,
  type CommandValidation, type SparqlResult } from '../../infrastructure/fuseki.ts';
import { profileValidations } from '../../infrastructure/profile.ts';
import { assertNotInvalidProfileReceipt, validatedCommand } from '../../infrastructure/invalid-receipt.ts';
import type { RegisteredAdmission } from '../access/admission.ts';
import { PRIVATE_SEARCH_GRAPH, privateDraftTriples } from './private-projection.ts';
import { serializeDocument } from '@rezics/document';
import { authoredDocumentBody, type AuthoredBodyInput } from '../../../../content/src/document-body.ts';
import { DATASET, GRAPHS, ID, RV, hash, iri, lit, prepareComponent,
  IdempotencyConflict, PendingActivation, CancelledActivation,
  type WorkActivationEnvironment } from '../work/activate.ts';

export const CONTRIBUTION_PROFILE = 'https://rezics.com/definition/text-contribution-v1';

/** One create-source read shares this response cap and wall deadline across its awaits. */
export const CONTRIBUTION_CREATE_READ_COST = {
  responseBytes: 16_384,
  objectBytes: 8_388_608,
  deadlineMs: 10_000,
} as const;

export class ContributionReadExpired extends Error {}

export function assertContributionReadOpen(signal: AbortSignal): void {
  if (signal.aborted) throw new ContributionReadExpired('contribution read expired');
}

/** Caller cancellation and one deadline cover every query in the read. */
export async function withContributionGraphRead<T>(
  calls: number, caller: AbortSignal | undefined, run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (!Number.isInteger(calls) || calls < 1) throw new Error('invalid contribution read call bound');
  const parent = fusekiReadBudget.getStore();
  const deadline = AbortSignal.timeout(CONTRIBUTION_CREATE_READ_COST.deadlineMs);
  const signal = AbortSignal.any([deadline, ...(caller ? [caller] : []), ...(parent ? [parent.signal] : [])]);
  assertContributionReadOpen(signal);
  const ceiling = CONTRIBUTION_CREATE_READ_COST.responseBytes * calls;
  const nested = { signal, callsLeft: calls, bytesLeft: ceiling };
  if (parent) {
    if (parent.callsLeft < 1 || parent.bytesLeft < 1) {
      throw new FusekiReadBudgetExceeded('contribution read exceeds its shared budget');
    }
    nested.callsLeft = Math.min(calls, parent.callsLeft);
    nested.bytesLeft = Math.min(ceiling, parent.bytesLeft);
    parent.callsLeft -= nested.callsLeft;
    parent.bytesLeft -= nested.bytesLeft;
  }
  try {
    return await fusekiReadBudget.run(nested, () => run(signal));
  } finally {
    if (parent) {
      parent.callsLeft += nested.callsLeft;
      parent.bytesLeft += nested.bytesLeft;
    }
  }
}

export async function queryContributionGraph(
  env: Pick<WorkActivationEnvironment, 'fuseki'>, sparql: string, signal: AbortSignal,
): Promise<SparqlResult> {
  assertContributionReadOpen(signal);
  try {
    return await env.fuseki.query(sparql, CONTRIBUTION_CREATE_READ_COST.responseBytes);
  } catch (error) {
    if (signal.aborted) throw new ContributionReadExpired('contribution read expired');
    throw error;
  }
}

export interface CreateTextContributionInput extends AuthoredBodyInput {
  work: string;
  language: string;
  actingSubject: string;
}

export interface TextContributionReceipt {
  outcome: 'succeeded' | 'cancelled';
  receipt: string;
  admissionId: string;
  requestDigest: string;
  authorityEpoch: string;
  scope: string;
  dataEpoch: string;
  sequence: string;
  work?: string;
  contribution?: string;
  draftRevision?: string;
  language?: string;
  author?: string;
}

export class ContributionWorkUnavailable extends Error {}
export class InvalidContributionInput extends Error {}

/** The create producer admits this spelling unchanged. Readers must not renormalize it. */
export function admittedContributionLanguage(language: string): boolean {
  return /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(language);
}

export function textContributionDigest(input: CreateTextContributionInput): string {
  let content;
  try { content = authoredDocumentBody(input); }
  catch { throw new InvalidContributionInput('invalid text Contribution body'); }
  if (!/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(input.work)
    || !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(input.actingSubject)
    || !admittedContributionLanguage(input.language)) {
    throw new InvalidContributionInput('invalid text Contribution input');
  }
  return hash(JSON.stringify({ family: 'create-text-contribution-v1', work: input.work,
    language: input.language, author: input.actingSubject,
    bodyDigest: hash(content.document ? serializeDocument(content.document) : JSON.stringify(content.body)) }));
}

export function textContributionReceiptIri(admissionId: string): string {
  return `urn:rezics:receipt:${hash(`${admissionId}\0create-text-contribution`)}`;
}

export async function readTextContributionReceipt(
  env: WorkActivationEnvironment, admissionId: string, options?: { signal?: AbortSignal },
): Promise<TextContributionReceipt | null> {
  return withContributionGraphRead(1, options?.signal, async signal => {
    const receipt = textContributionReceiptIri(admissionId);
    const result = await queryContributionGraph(env, `PREFIX rv: <${RV}> SELECT
      ?outcome ?digest ?id ?epoch ?scope ?dataEpoch ?sequence ?work ?contribution
      ?draftRevision ?language ?author WHERE { GRAPH ${iri(GRAPHS.receipts)} {
      ${iri(receipt)} a rv:OperationReceipt ; rv:outcome ?outcome ;
        rv:requestDigest ?digest ; rv:admissionId ?id ; rv:authorityEpoch ?epoch ;
        rv:admittedScope ?scope ; rv:dataEpoch ?dataEpoch ; rv:sequence ?sequence .
      OPTIONAL { ${iri(receipt)} rv:work ?work ; rv:contribution ?contribution ;
        rv:draftRevision ?draftRevision ; rv:language ?language ; rv:author ?author }
    } } LIMIT 2`, signal);
    assertContributionReadOpen(signal);
    const rows = result.results?.bindings ?? [];
    if (rows.length === 0) return null;
    if (rows.length !== 1) throw new Error('Contribution receipt cardinality violation');
    const row = rows[0]!;
    const value = (key: string, kind: 'uri' | 'literal') => {
      const term = row[key];
      if (!term?.value || term.type !== kind || term['xml:lang'] !== undefined) return undefined;
      if (kind === 'uri' && term.datatype !== undefined) return undefined;
      return term.value;
    };
    const outcome = value('outcome', 'uri') === `${RV}Succeeded` ? 'succeeded'
      : value('outcome', 'uri') === `${RV}Cancelled` ? 'cancelled' : null;
    if (!outcome || !value('digest', 'literal') || !value('id', 'literal') || !value('epoch', 'literal')
      || !value('scope', 'literal') || !value('dataEpoch', 'literal')
      || !/^[0-9]+$/.test(value('sequence', 'literal') ?? '')
      || (outcome === 'succeeded' && (!value('work', 'uri') || !value('contribution', 'uri')
        || !value('draftRevision', 'uri') || !value('language', 'literal') || !value('author', 'uri')))
      || (outcome === 'cancelled' && ['work', 'contribution', 'draftRevision', 'language', 'author']
        .some(key => row[key] !== undefined))) {
      throw new Error('Contribution receipt is incomplete');
    }
    assertContributionReadOpen(signal);
    return { outcome, receipt, admissionId: value('id', 'literal')!, requestDigest: value('digest', 'literal')!,
      authorityEpoch: value('epoch', 'literal')!, scope: value('scope', 'literal')!,
      dataEpoch: value('dataEpoch', 'literal')!, sequence: value('sequence', 'literal')!,
      ...(outcome === 'succeeded' ? { work: value('work', 'uri'), contribution: value('contribution', 'uri'),
        draftRevision: value('draftRevision', 'uri'), language: value('language', 'literal'),
        author: value('author', 'uri') } : {}) };
  });
}

export async function assertCurrentContributionWork(
  env: WorkActivationEnvironment, work: string,
): Promise<void> {
  const result = await env.fuseki.query(`PREFIX schema: <https://schema.org/>
    ASK { GRAPH ${iri(GRAPHS.current)} { ${iri(work)} a schema:CreativeWork } }`);
  if (result.boolean !== true) throw new ContributionWorkUnavailable('Work is unavailable');
}

export async function validateTextContributionCandidate(env: WorkActivationEnvironment, contribution: string,
  revision: string, input: CreateTextContributionInput): Promise<CommandValidation[]> {
  iri(contribution); iri(revision); textContributionDigest(input);
  return profileValidations(env.fuseki, 'text-contribution-v1', [{
    shape: `${CONTRIBUTION_PROFILE}/contribution-shape`, focus: [contribution],
    graphs: [GRAPHS.current],
  }]);
}

function matches(receipt: TextContributionReceipt, admission: RegisteredAdmission,
  digest: string): boolean {
  return receipt.admissionId === admission.id && receipt.requestDigest === digest
    && receipt.authorityEpoch === admission.authorityEpoch && receipt.scope === admission.scope;
}

export async function activateTextContribution(
  env: WorkActivationEnvironment, admission: RegisteredAdmission,
  input: CreateTextContributionInput,
): Promise<TextContributionReceipt> {
  const digest = textContributionDigest(input);
  const content = authoredDocumentBody(input);
  if (admission.action !== 'contribution.create'
    || admission.scope !== `contribution:create:${input.work}`
    || admission.actingSubject !== input.actingSubject
    || admission.requestDigest !== digest) {
    throw new IdempotencyConflict('Contribution admission differs from intent');
  }
  await assertNotInvalidProfileReceipt(env.fuseki, textContributionReceiptIri(admission.id));
  const existing = await readTextContributionReceipt(env, admission.id);
  if (existing) {
    if (!matches(existing, admission, digest)) throw new IdempotencyConflict('Contribution receipt differs');
    if (existing.outcome === 'cancelled') throw new CancelledActivation('Contribution admission was cancelled');
    return existing;
  }
  if (Date.parse(admission.expiresAt) <= Date.now()) throw new PendingActivation('Contribution admission expired');
  await assertCurrentContributionWork(env, input.work);
  const contribution = ID + Bun.randomUUIDv7();
  const draftRevision = ID + Bun.randomUUIDv7();
  const operation = ID + Bun.randomUUIDv7();
  const receipt = textContributionReceiptIri(admission.id);
  const validations = await validateTextContributionCandidate(env, contribution, draftRevision, input);
  const manifest = prepareComponent(env.objectDirectory, contribution,
    { work: input.work, author: input.actingSubject, language: input.language,
      ...content, publication: 'draft' }, CONTRIBUTION_PROFILE);
  if (Date.parse(admission.expiresAt) <= Date.now()) throw new PendingActivation('Contribution admission expired');
  const batch = `urn:rezics:outbox:${hash(receipt)}`;
  const event = `urn:rezics:event:${hash(operation)}`;
  let updateError: unknown;
  try {
    const result = await validatedCommand(env, { receipt, digest, validations, deadlineMs: 10_000,
      update: `PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
      DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n } }
      INSERT {
        GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
        GRAPH ${iri(GRAPHS.current)} {
          ${iri(contribution)} a rv:TextContribution ; rv:work ${iri(input.work)} ;
            rv:author ${iri(input.actingSubject)} ; rv:language ${lit(input.language)} ;
            rv:draftHead ${iri(draftRevision)} .
        }
        GRAPH ${iri(GRAPHS.revisions)} {
          ${iri(draftRevision)} a rv:RevisionAnchor ; rv:component ${iri(contribution)} ;
            rv:operation ${iri(operation)} ; rv:manifest ${iri(`urn:rezics:sha256:${manifest}`)} ;
            rv:modelRevision ${iri(CONTRIBUTION_PROFILE)} ;
            rv:shapeRevision ${iri(CONTRIBUTION_PROFILE)} ; rv:datasetId ${iri(DATASET)} ;
            rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next .
        }
        GRAPH ${iri(PRIVATE_SEARCH_GRAPH)} {
          ${privateDraftTriples(contribution, draftRevision, input.work, input.language, content.body)}
        }
        GRAPH ${iri(GRAPHS.receipts)} {
          ${iri(receipt)} a rv:OperationReceipt ; rv:operation ${iri(operation)} ;
            rv:requestDigest ${lit(digest)} ; rv:admissionId ${lit(admission.id)} ;
            rv:authorityEpoch ${lit(admission.authorityEpoch)} ;
            rv:admittedScope ${lit(admission.scope)} ; rv:outcome rv:Succeeded ;
            rv:work ${iri(input.work)} ; rv:contribution ${iri(contribution)} ;
            rv:draftRevision ${iri(draftRevision)} ; rv:language ${lit(input.language)} ;
            rv:author ${iri(input.actingSubject)} ; rv:datasetId ${iri(DATASET)} ;
            rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next .
        }
        GRAPH ${iri(GRAPHS.outbox)} {
          ${iri(batch)} a rv:OutboxBatch ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
            rv:sequence ?next ; rv:eventCount 1 ; rv:event ${iri(event)} .
          ${iri(event)} a rv:ContributionDraftCreatedEvent ; rv:ordinal 0 ;
            rv:action "contribution.create" ; rv:receipt ${iri(receipt)} ;
            rv:operation ${iri(operation)} ; rv:work ${iri(input.work)} ;
            rv:contribution ${iri(contribution)} .
        }
      }
      WHERE {
        GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
          rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
        GRAPH ${iri(GRAPHS.current)} { ${iri(input.work)} a schema:CreativeWork . }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(contribution)} ?p ?o } }
        BIND(?n + 1 AS ?next)
      }` }, admission);
    if (result.status === 'unknown-profile') throw new CommandRejected(result);
    if (result.status === 'invalid') {
      throw new InvalidContributionInput(`Contribution validation ${result.status}`);
    }
  } catch (error) {
    if (error instanceof InvalidContributionInput || error instanceof CommandRejected) throw error;
    updateError = error;
  }
  const committed = await readTextContributionReceipt(env, admission.id);
  if (!committed) throw new PendingActivation(updateError
    ? 'Contribution update outcome is unknown' : 'Contribution guard did not match');
  if (!matches(committed, admission, digest)) throw new IdempotencyConflict('Contribution receipt differs');
  if (committed.outcome !== 'succeeded' || committed.work !== input.work
    || committed.author !== input.actingSubject || committed.language !== input.language) {
    throw new IdempotencyConflict('Contribution receipt targets another intent');
  }
  return committed;
}

/** Strong closure seals a pending draft admission without publishing it. */
export async function sealTextContributionAdmission(
  env: WorkActivationEnvironment, admission: RegisteredAdmission,
): Promise<TextContributionReceipt> {
  if (admission.action !== 'contribution.create') throw new Error('unsupported Contribution admission');
  const existing = await readTextContributionReceipt(env, admission.id);
  if (existing) {
    if (!matches(existing, admission, admission.requestDigest)) throw new IdempotencyConflict('Contribution receipt differs');
    return existing;
  }
  const receipt = textContributionReceiptIri(admission.id);
  const batch = `urn:rezics:outbox:${hash(`${receipt}\0cancel`)}`;
  const event = `urn:rezics:event:${hash(`${receipt}\0cancel`)}`;
  try { await env.fuseki.commandWithReceipt({ receipt, digest: admission.requestDigest,
    validations: [], deadlineMs: 10_000, update: `PREFIX rv: <${RV}>
    DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n } }
    INSERT {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
      GRAPH ${iri(GRAPHS.receipts)} {
        ${iri(receipt)} a rv:OperationReceipt ; rv:requestDigest ${lit(admission.requestDigest)} ;
          rv:admissionId ${lit(admission.id)} ; rv:authorityEpoch ${lit(admission.authorityEpoch)} ;
          rv:admittedScope ${lit(admission.scope)} ; rv:outcome rv:Cancelled ;
          rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next .
      }
      GRAPH ${iri(GRAPHS.outbox)} { ${iri(batch)} a rv:OutboxBatch ;
        rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next ;
        rv:eventCount 1 ; rv:event ${iri(event)} .
        ${iri(event)} a rv:ContributionAdmissionCancelledEvent ; rv:ordinal 0 ;
          rv:action "contribution.create" ; rv:receipt ${iri(receipt)} . }
    }
    WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
      BIND(?n + 1 AS ?next)
    }` }); } catch { /* resolve an ambiguous update from the receipt */ }
  const terminal = await readTextContributionReceipt(env, admission.id);
  if (!terminal || !matches(terminal, admission, admission.requestDigest)) {
    throw new PendingActivation('Contribution cancellation outcome is unknown');
  }
  return terminal;
}
