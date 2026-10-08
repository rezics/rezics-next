import { t } from 'elysia';
import type { Static } from 'typebox';
import { Value } from 'typebox/value';
import type { CatalogueBulkEnvelope, CommandValidation } from '../../infrastructure/fuseki.ts';
import { WorkFileStaging } from './file-staging.ts';
import { profileRegistry } from '../../../../../packages/model/src/generated/profiles.ts';
import { AdmissionConflict, type RegisteredAdmission } from '../access/admission.ts';
import { canonicalLanguage } from '../display-language/select.ts';
import { catalogueTitleKey } from '../catalogue-intake/title-keys.ts';
import { GLOBAL_CLASSIFICATION_CONTEXT, CLASSIFICATION_ISOLATE_POLICY } from '../classification/context.ts';
import { CLASSIFICATION_PROPOSITION_PROFILE } from '../classification/proposition.ts';
import { activeDirectDefinitionsGuard } from '../context/definition-state.ts';
import { CLASSIFIED_AS, STATEMENT_PROFILE, STATEMENT_DECISION_PROFILE,
  decisionSlotIri, statementMeaningKey, type StatementMeaning } from '../statement/schema.ts';
import type { MainWorkDependencies } from '../../routes/dependencies.ts';
import { assertGraphAdmissionOpen } from './restore-lineage.ts';
import { discardUnpublishedWorkObjects, stagedWorkObjectCandidates, type StagedWorkObjectCandidates } from './object-gc.ts';
import { sealMetadataWorkAdmission } from './seal.ts';
import { readWorkTerminalReceipt, workReceiptIri, type WorkTerminalReceipt } from './receipt.ts';
import { nativeCreditRole } from './read-contract.ts';
import { CONTINUITY, DATASET, GRAPHS, ID, PROFILE, RV, hash, iri, lit,
  metadataWorkRequestDigest, normalizeWorkSemanticTypes, prepareComponentWithCandidates, prepareWorkComponentWithCandidates, type WorkActivationEnvironment } from './activate.ts';

/** Creation-only catalogue capability. It includes initial attribution and global
 * curation; ordinary work:create:root permission never grants this scope. */
export const CATALOGUE_IMPORT_SCOPE = 'work:create:catalogue-import';
export const CATALOGUE_IMPORT_COST = { items: 128, credits: 8, classifications: 8,
  requestBytes: 1024 * 1024, itemBytes: 16 * 1024, commandBytes: 16_000_000,
  stagedQuads: 16_384, deadlineMs: 30_000 } as const;
const closed = { additionalProperties: false } as const;
const native = t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' });
const text = (maxLength: number) => t.String({ minLength: 1, maxLength, pattern: '^[^\\u0000-\\u001f\\u007f]+$' });
const language = t.String({ minLength: 2, maxLength: 35 });
const namedText = t.Object({ value: text(500), language }, closed);
export const catalogueImportInput = t.Object({
  profile: t.Literal('work-catalogue-import-v1'),
  /** An optional importer identity, never inferred from a matching title. */
  work: t.Optional(native), expectedWorkHead: t.Null(),
  title: text(200), language, evidence: text(2000),
  localizedTitle: t.Optional(namedText),
  description: t.Optional(t.Object({ value: text(4000), language }, closed)),
  aliases: t.Array(namedText, { maxItems: 8 }),
  semanticTypes: t.Array(t.String(), { maxItems: 3, uniqueItems: true }),
  credits: t.Array(t.Object({ agent: native, expectedAgentHead: t.Optional(native),
    role: nativeCreditRole }, closed), { maxItems: 8 }),
  classifications: t.Array(t.Object({ concept: native, definition: native,
    expectedDecisionHead: t.Null(), outcome: t.Union([t.Literal('accepted'), t.Literal('rejected')]) }, closed), { maxItems: 8 }),
}, closed);
export type CatalogueImportInput = Static<typeof catalogueImportInput>;
export class InvalidCatalogueImport extends Error {}
export interface CatalogueImportOutcome {
  key: string;
  status: 'succeeded' | 'denied' | 'invalid' | 'conflict' | 'pending';
  receipt?: WorkTerminalReceipt;
  replayed?: boolean;
}
function checked(input: CatalogueImportInput): CatalogueImportInput {
  if (!Value.Check(catalogueImportInput, input) || Buffer.byteLength(JSON.stringify(input)) > CATALOGUE_IMPORT_COST.itemBytes)
    throw new InvalidCatalogueImport('Catalogue item does not match its bounded schema');
  const normalize = (row: { value: string; language: string }) => {
    const tag = canonicalLanguage(row.language);
    if (!tag) throw new InvalidCatalogueImport('Invalid recorded language');
    return { value: row.value, language: tag };
  };
  const tag = canonicalLanguage(input.language);
  if (!tag || new Set(input.credits.map(row => `${row.agent}\0${row.role}`)).size !== input.credits.length
    || new Set(input.classifications.map(row => `${row.concept}\0${row.definition}`)).size !== input.classifications.length)
    throw new InvalidCatalogueImport('Languages and credit/classification slots must be valid and unique');
  const result: CatalogueImportInput = { profile: input.profile, ...(input.work ? { work: input.work } : {}),
    expectedWorkHead: null, title: input.title, language: tag, evidence: input.evidence,
    aliases: input.aliases.map(normalize),
    ...(input.localizedTitle ? { localizedTitle: normalize(input.localizedTitle) } : {}),
    ...(input.description ? { description: normalize(input.description) } : {}),
    semanticTypes: [...input.semanticTypes].sort(),
    credits: input.credits.map(row => ({ agent: row.agent, role: row.role,
      ...(row.expectedAgentHead ? { expectedAgentHead: row.expectedAgentHead } : {}) })),
    classifications: input.classifications.map(row => ({ concept: row.concept, definition: row.definition,
      expectedDecisionHead: null, outcome: row.outcome })) };
  // Apply the same title and semantic type policy as ordinary creation.
  try { metadataWorkRequestDigest(result.title, result.semanticTypes, result.language, result, true); }
  catch (error) { throw new InvalidCatalogueImport(error instanceof Error ? error.message : 'Invalid Work metadata'); }
  return result;
}
export function catalogueImportDigest(input: CatalogueImportInput, actingSubject: string): string {
  if (!Value.Check(native, actingSubject)) throw new InvalidCatalogueImport('Invalid acting Agent');
  return hash(JSON.stringify({ family: 'work-catalogue-import-v1', actingSubject, input: checked(input) }));
}
function identity(admission: string, kind: string): string {
  const digest = hash(`${admission}\0${kind}`).slice(0, 32);
  return `${ID}${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20)}`;
}
export { identity as catalogueImportIdentity };
function validation(profile: keyof typeof profileRegistry, role: string, focus: string[], binding?: Record<string, string>): CommandValidation {
  const pin = profileRegistry[profile];
  const shape = `https://rezics.com/definition/${profile}/${role}-shape`;
  if (!(pin.shapes as readonly string[]).includes(shape)) throw new Error(`Unreviewed catalogue shape ${shape}`);
  return { profile, sha256: pin.sha256, shape, focus, graphs: [GRAPHS.current, GRAPHS.revisions],
    ...(binding ? { binding } : {}) };
}
export async function prepareCatalogueImport(env: WorkActivationEnvironment, admission: RegisteredAdmission, input: CatalogueImportInput, candidates: StagedWorkObjectCandidates[], agentHeads: Map<string, string>, files?: WorkFileStaging): Promise<CatalogueBulkEnvelope> {
  const receipt = workReceiptIri(admission.id), work = input.work ?? identity(admission.id, 'work');
  const main = identity(admission.id, 'main'), revision = identity(admission.id, 'work-revision');
  const mainRevision = identity(admission.id, 'main-revision'), operation = identity(admission.id, 'operation');
  const manifest = async (component: string, state: object, profile = PROFILE) => {
    const staged = stagedWorkObjectCandidates();
    candidates.push(staged);
    return files ? files.component(component, state, staged, profile)
      : env.workObjects ? prepareWorkComponentWithCandidates(env.workObjects, component, state, staged, profile)
      : prepareComponentWithCandidates(env.objectDirectory, component, state, staged, profile);
  };
  const mainManifest = await manifest(main, { work, hostingPolicy: 'metadata-only' });
  const validations: CommandValidation[] = [
    validation('work-metadata-v1', 'work', [work]),
    validation('work-metadata-v1', 'main-version', [main]),
    validation('work-kind-v3', 'work', [work]),
  ];
  const current: string[] = [], revisions: string[] = [], guards: string[] = [];
  const missing = [...new Set(input.credits.filter(row => !row.expectedAgentHead && !agentHeads.has(row.agent)).map(row => row.agent))];
  if (missing.length) {
    const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?agent ?head WHERE {
      VALUES ?agent { ${missing.map(iri).join(' ')} }
      GRAPH ${iri(GRAPHS.current)} { ?agent a rv:Agent ; rv:head ?head }
    }`, 8192)).results?.bindings ?? [];
    for (const row of rows) if (row.agent && row.head) agentHeads.set(row.agent.value, row.head.value);
  }
  for (const [index, credit] of input.credits.entries()) {
    const agentHead = credit.expectedAgentHead ?? agentHeads.get(credit.agent);
    // An unavailable Agent makes the candidate's guarded creation stale. It
    // never leaves a Work without the explicit attribution the caller supplied.
    const expectedAgentHead = agentHead ?? identity(admission.id, `absent-agent:${index}`);
    const id = identity(admission.id, `credit:${index}`), head = identity(admission.id, `credit-revision:${index}`);
    current.push(`${iri(id)} a rv:NativeAgentCredit ; rv:work ${iri(work)} ; rv:agent ${iri(credit.agent)} ; rv:creditRevision ${iri(head)} ; schema:roleName ${lit(credit.role)} .`);
    revisions.push(`${iri(head)} a rv:NativeAgentCreditRevision, rv:RevisionAnchor ; rv:component ${iri(id)} ; rv:work ${iri(work)} ; rv:agent ${iri(credit.agent)} ; schema:roleName ${lit(credit.role)} ; rv:workRevision ${iri(revision)} ; rv:agentRevision ${iri(expectedAgentHead)} ; rv:modelRevision <https://rezics.com/definition/native-agent-credit-v1> ; rv:shapeRevision <https://rezics.com/definition/native-agent-credit-v1> ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next .`);
    guards.push(`GRAPH ${iri(GRAPHS.current)} { ${iri(credit.agent)} a rv:Agent ; rv:head ${iri(expectedAgentHead)} }
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(expectedAgentHead)} a rv:RevisionAnchor ; rv:component ${iri(credit.agent)} }`);
    validations.push(validation('native-agent-credit-v1', 'credit', [id]), validation('native-agent-credit-v1', 'revision', [head]));
  }
  for (const [index, row] of input.classifications.entries()) {
    const statement = identity(admission.id, `statement:${index}`);
    const head = identity(admission.id, `statement-revision:${index}`);
    const decision = identity(admission.id, `decision:${index}`);
    const meaning: StatementMeaning = { subject: main, predicate: CLASSIFIED_AS,
      relationDefinition: CLASSIFICATION_PROPOSITION_PROFILE, interpretationDefinitions: [row.definition],
      value: { kind: 'resource', iri: row.concept }, applicability: [] };
    const meaningKey = statementMeaningKey(meaning);
    const target = { kind: 'qualified-fact' as const, meaningKey };
    const slot = decisionSlotIri(target, GLOBAL_CLASSIFICATION_CONTEXT);
    const statementManifest = await manifest(statement, { revision: head, meaning, meaningKey,
      speaker: admission.actingSubject, semanticContextRevision: null, state: 'active', evidence: [],
      recordedBy: admission.actingSubject }, STATEMENT_PROFILE);
    const decisionManifest = await manifest(slot, { decision, target, support: [statement],
      acceptanceContext: GLOBAL_CLASSIFICATION_CONTEXT, contextRevision: null, predecessor: null,
      outcome: row.outcome, basis: 'GlobalCuratorReview', decidedBy: admission.actingSubject,
      targetRevision: null }, STATEMENT_DECISION_PROFILE);
    current.push(`${iri(statement)} a rdf:Statement ; rdf:subject ${iri(main)} ; rdf:predicate <${CLASSIFIED_AS}> ;
      rdf:object ${iri(row.concept)} ; rv:relationDefinition ${iri(CLASSIFICATION_PROPOSITION_PROFILE)} ;
      rv:interpretationDefinition ${iri(row.definition)} ; rv:speaker ${iri(admission.actingSubject)} ;
      rv:meaningKey ${iri(meaningKey)} ; rv:statementState rv:Active ; rv:head ${iri(head)} .
      ${iri(slot)} a rv:DecisionSlot ; rv:targetKind rv:QualifiedFactTarget ; rv:decisionTarget ${iri(meaningKey)} ;
      rv:acceptanceContext ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} ; rv:decisionHead ${iri(decision)} .`);
    revisions.push(`${iri(head)} a rv:StatementRevision, rv:RevisionAnchor ; rv:component ${iri(statement)} ;
      rv:statementState rv:Active ; rv:recordedBy ${iri(admission.actingSubject)} ; rv:operation ${iri(operation)} ;
      rv:manifest ${iri(`urn:rezics:sha256:${statementManifest}`)} ; rv:modelRevision ${iri(STATEMENT_PROFILE)} ;
      rv:shapeRevision ${iri(STATEMENT_PROFILE)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next .
      ${iri(decision)} a rv:StatementDecision, rv:RevisionAnchor ; rv:component ${iri(slot)} ; rv:operation ${iri(operation)} ;
      rv:outcome rv:${row.outcome === 'accepted' ? 'Accepted' : 'Rejected'} ; rv:decisionBasis rv:GlobalCuratorReview ;
      rv:decidedBy ${iri(admission.actingSubject)} ; rv:decisionPolicy ${iri(STATEMENT_DECISION_PROFILE)} ;
      rv:support ${iri(statement)} ; rv:manifest ${iri(`urn:rezics:sha256:${decisionManifest}`)} ;
      rv:modelRevision ${iri(STATEMENT_DECISION_PROFILE)} ; rv:shapeRevision ${iri(STATEMENT_DECISION_PROFILE)} ;
      rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next .`);
    validations.push(validation('statement-v1', 'statement', [statement]), validation('statement-v1', 'revision', [head]),
      validation('statement-decision-v1', 'slot', [slot]), validation('statement-decision-v1', 'decision', [decision]));
    guards.push(`GRAPH ${iri(GRAPHS.current)} { ${iri(row.concept)} a <http://www.w3.org/2004/02/skos/core#Concept> .
      ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} a rv:ClassificationContext ; rv:contextState rv:Active ; rv:contextRole rv:GlobalClassification ; rv:inheritancePolicy ${iri(CLASSIFICATION_ISOLATE_POLICY)} .
      FILTER NOT EXISTS { ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} rv:realm ?realm }
      FILTER NOT EXISTS { ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} rv:fallbackContext ?fallback } }
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(row.definition)} a rv:RevisionAnchor . }
      ${activeDirectDefinitionsGuard([CLASSIFICATION_PROPOSITION_PROFILE, row.definition])}
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(slot)} ?occupied${index} ?value${index} } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(statement)} ?sp${index} ?sv${index} } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ${iri(head)} ?hp${index} ?hv${index} } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ${iri(decision)} ?dp${index} ?dv${index} } }`);
  }
  const expiryGuard = `FILTER(NOW() < ${lit(admission.expiresAt)}^^<http://www.w3.org/2001/XMLSchema#dateTime>)`;
  const workManifest = await manifest(work, { mainVersion: main, continuityProfile: CONTINUITY,
    ...input, creditHeads: Object.fromEntries(input.credits.map((credit,index) => [credit.agent,
      credit.expectedAgentHead ?? agentHeads.get(credit.agent) ?? identity(admission.id, `absent-agent:${index}`)])) });
  const commonGuard = `GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n }
    FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
    FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
    BIND(?n + 1 AS ?next)`;
  const receiptFields = `a rv:OperationReceipt ; rv:requestDigest ${lit(admission.requestDigest)} ; rv:admissionId ${lit(admission.id)} ; rv:authorityEpoch ${lit(admission.authorityEpoch)} ; rv:admittedScope ${lit(admission.scope)} ; rv:commandFamily "work-catalogue-import-v1" ; rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next`;
  const batch = `urn:rezics:outbox:${hash(receipt)}`, event = `urn:rezics:event:${hash(operation)}`;
  const names = [...input.aliases, ...(input.localizedTitle ? [input.localizedTitle] : [])];
  const envelope: CatalogueBulkEnvelope = { receipt, digest: admission.requestDigest, deadlineMs: CATALOGUE_IMPORT_COST.deadlineMs, validations,
    update: `PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/> PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
    PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
    DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n } }
    INSERT {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
      GRAPH ${iri(GRAPHS.current)} {
        ${iri(work)} a schema:CreativeWork${input.semanticTypes.map(type => `, <${type}>`).join('')} ; rv:mainVersion ${iri(main)} ; rv:continuityProfile ${iri(CONTINUITY)} ; rdfs:label ${lit(input.title)}@${input.language} ; rv:head ${iri(revision)} ; rv:catalogueVisible true ; rv:provisional false ; rv:declaredGrain "new-creative-scope" ; rv:importProvenance ${lit(JSON.stringify({ basis: 'catalogue-import', revision, admission: admission.id, contributor: admission.actingSubject, evidence: input.evidence, fields: ['title', 'language', 'aliases', 'description', 'semanticTypes', 'credits', 'classifications'] }))} .
        ${[...new Set([input.title, ...names.map(row => row.value)].map(catalogueTitleKey))].map(key => `${iri(work)} rv:catalogueTitleKey ${lit(key)} .`).join('\n')}
        ${names.map(row => `${iri(work)} schema:alternateName ${lit(row.value)}@${row.language} .`).join('\n')}
        ${input.description ? `${iri(work)} schema:description ${lit(input.description.value)}@${input.description.language} .` : ''}
        ${iri(main)} a rv:MainVersion ; rv:work ${iri(work)} ; rv:hostingPolicy rv:MetadataOnly ; rv:head ${iri(mainRevision)} .
        ${current.join('\n')}
      }
      GRAPH ${iri(GRAPHS.revisions)} {
        ${iri(revision)} a rv:RevisionAnchor ; rv:component ${iri(work)} ; rv:operation ${iri(operation)} ; rv:manifest ${iri(`urn:rezics:sha256:${workManifest}`)} ; rv:modelRevision ${iri(PROFILE)} ; rv:shapeRevision ${iri(PROFILE)} ; rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next .
        ${iri(mainRevision)} a rv:RevisionAnchor ; rv:component ${iri(main)} ; rv:operation ${iri(operation)} ; rv:manifest ${iri(`urn:rezics:sha256:${mainManifest}`)} ; rv:modelRevision ${iri(PROFILE)} ; rv:shapeRevision ${iri(PROFILE)} ; rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next .
        ${revisions.join('\n')}
      }
      GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ${receiptFields} ; rv:outcome rv:Succeeded ; rv:operation ${iri(operation)} ; rv:work ${iri(work)} ; rv:mainVersion ${iri(main)} ; rv:workRevision ${iri(revision)} ; rv:mainRevision ${iri(mainRevision)} . }
      GRAPH ${iri(GRAPHS.outbox)} { ${iri(batch)} a rv:OutboxBatch ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next ; rv:eventCount 1 ; rv:event ${iri(event)} .
        ${iri(event)} a rv:WorkCreatedEvent ; rv:ordinal 0 ; rv:action "work.create" ; rv:receipt ${iri(receipt)} ; rv:operation ${iri(operation)} ; rv:work ${iri(work)} . }
    } WHERE { ${commonGuard} ${expiryGuard}
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(work)} ?occupiedProperty ?occupiedValue } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(main)} ?mp ?mo } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} ?rp ?ro } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ${iri(mainRevision)} ?mrp ?mro } }
      ${guards.join('\n')}
    }`,
    cancellation: `PREFIX rv: <${RV}>
      DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n } }
      INSERT { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
        GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ${receiptFields} ; rv:outcome rv:Cancelled ; rv:importFailure "candidate-failed" . }
        GRAPH ${iri(GRAPHS.outbox)} { ${iri(batch)} a rv:OutboxBatch ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next ; rv:eventCount 1 ; rv:event ${iri(event)} .
          ${iri(event)} a rv:AdmissionCancelledEvent ; rv:ordinal 0 ; rv:action "work.create" ; rv:receipt ${iri(receipt)} ; rv:admissionId ${lit(admission.id)} . }
      } WHERE { ${commonGuard} }`,
  };
  try { normalizeWorkSemanticTypes(input.semanticTypes); }
  catch {
    // Retired types still replay a prior terminal receipt, but cannot create a
    // new Work. This admitted failure has the same stable cancellation identity.
    envelope.update = envelope.cancellation.replace('"candidate-failed"', '"invalid"');
    envelope.validations = [];
  }
  return envelope;
}

async function terminalStatus(env: WorkActivationEnvironment, terminal: WorkTerminalReceipt): Promise<CatalogueImportOutcome['status']> {
  if (terminal.outcome === 'succeeded') return 'succeeded';
  const reason = await env.fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH ${iri(GRAPHS.receipts)} {
    ${iri(terminal.receipt)} rv:importFailure "invalid" } }`, 1024);
  return reason.boolean === true ? 'invalid' : 'conflict';
}

/** O(items × (credits + classifications)) bounded admission, object staging and
 * node-local validation; no corpus enumeration, receipt/history replay or bulk
 * loader. The native writer commits once; per-item logical sequences preserve
 * existing relay/recovery ordering. Unknown native index page work is unmeasured. */
export async function importCatalogueWorks(deps: MainWorkDependencies, request: Request,
  actingSubject: string, items: readonly { key: string; input: CatalogueImportInput }[]): Promise<CatalogueImportOutcome[]> {
  if (items.length < 1 || items.length > CATALOGUE_IMPORT_COST.items
    || new Set(items.map(item => item.key)).size !== items.length
    || items.some(item => !/^[A-Za-z0-9:_./-]{1,128}$/.test(item.key))
    || Buffer.byteLength(JSON.stringify(items)) > CATALOGUE_IMPORT_COST.requestBytes)
    throw new InvalidCatalogueImport('Invalid catalogue batch size, keys or bytes');
  const admit = deps.access.admitCatalogue?.bind(deps.access), record = deps.access.recordCatalogueOutcomes?.bind(deps.access);
  if (!admit || !record) throw new Error('Catalogue admission transaction is unavailable');
  await assertGraphAdmissionOpen(deps.environment.fuseki, deps.environment.lineage);
  const principal = await deps.account.verify(request,
    items.some(item => item.input.classifications.length > 0) ? ['work:create', 'classification:decide'] : ['work:create']);
  const outcomes: CatalogueImportOutcome[] = items.map(item => ({ key: item.key, status: 'pending' }));
  const prepared: { index: number; admission: RegisteredAdmission; envelope: CatalogueBulkEnvelope; candidates: StagedWorkObjectCandidates[] }[] = [];
  const admissions: { index: number; admission: RegisteredAdmission; input: CatalogueImportInput }[] = [];
  const requests: { index: number; input: CatalogueImportInput; key: string; digest: string }[] = [];
  for (const [index, item] of items.entries()) {
    try { const input = checked(item.input); requests.push({ index, input, key: item.key, digest: catalogueImportDigest(input, actingSubject) }); }
    catch (error) { if (error instanceof InvalidCatalogueImport) outcomes[index]!.status = 'invalid'; else throw error; }
  }
  if (requests.length) {
    const registered = await admit(principal, actingSubject, requests.map(({ key, digest }) => ({ key, digest })));
    for (const [offset, result] of registered.entries()) {
      const row = requests[offset]!;
      if ('status' in result) outcomes[row.index]!.status = result.status;
      else admissions.push({ index: row.index, admission: result.admission, input: row.input });
    }
  }
  const terminals: { index: number; admission: RegisteredAdmission; terminal: WorkTerminalReceipt }[] = [];
  const agentHeads = new Map<string, string>();
  const files = !deps.environment.workObjects ? new WorkFileStaging(deps.environment.objectDirectory) : undefined;
  const pendingPreparation: typeof admissions = [];
  for (const { index, admission, input } of admissions) {
    const existing = await readWorkTerminalReceipt(deps.environment.fuseki, admission.id);
    if (existing) { terminals.push({ index, admission, terminal: existing }); continue; }
    if (!admission.dispatchEligible || admission.state === 'sealed') {
      terminals.push({ index, admission, terminal: await sealMetadataWorkAdmission(deps.environment, admission) });
      continue;
    }
    pendingPreparation.push({ index, admission, input });
  }
  // Four preparations × two file syncs: bounded I/O can share the filesystem
  // journal, while each payload is synced before the final directory fence.
  for (let start = 0; start < pendingPreparation.length; start += 4) {
    const results = await Promise.allSettled(pendingPreparation.slice(start, start + 4).map(async ({ index, admission, input }) => {
    const candidates: StagedWorkObjectCandidates[] = [];
    try { prepared.push({ index, admission, envelope: await prepareCatalogueImport(deps.environment, admission, input, candidates, agentHeads, files), candidates }); }
    catch (error) {
      // Deterministic same-key objects may be shared with another in-flight
      // writer. Only a durable cancellation makes their deletion safe.
      throw error;
    }
    }));
    const failures = results.filter(result => result.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Catalogue object preparation failed');
  }
  if (prepared.length) await files?.flush();
  prepared.sort((left, right) => left.index - right.index);
  if (prepared.length) {
    try { await deps.environment.fuseki.catalogueBatch(prepared.map(row => row.envelope)); }
    catch { /* The shared commit can succeed before its response is lost. Read each receipt. */ }
  }
  for (const row of prepared) {
    const terminal = await readWorkTerminalReceipt(deps.environment.fuseki, row.admission.id);
    if (terminal) terminals.push({ index: row.index, admission: row.admission, terminal });
  }
  try {
    // Access ambiguity keeps every affected item pending. The graph receipts
    // remain authoritative and the same item keys reconcile all of them.
    for (const { terminal, admission } of terminals) {
      if (terminal.requestDigest !== admission.requestDigest || terminal.scope !== admission.scope
        || terminal.admissionId !== admission.id || terminal.authorityEpoch !== admission.authorityEpoch)
        throw new AdmissionConflict('Catalogue receipt differs from admission');
    }
    await record(terminals.map(row => row.terminal));
    for (const row of terminals) {
      outcomes[row.index] = { key: items[row.index]!.key, status: await terminalStatus(deps.environment, row.terminal),
        receipt: row.terminal, replayed: row.admission.replayed };
      if (row.terminal.outcome === 'cancelled') {
        const staged = prepared.find(item => item.index === row.index);
        if (staged) for (const candidates of staged.candidates) await discardUnpublishedWorkObjects({ fuseki: deps.environment.fuseki,
          objects: deps.environment.workObjects, objectDirectory: deps.environment.objectDirectory, candidates });
      }
    }
  } catch { /* No durable Access acknowledgement: retry every pending item. */ }
  return outcomes;
}
