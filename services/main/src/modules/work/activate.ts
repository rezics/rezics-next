import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CommandRejected, FusekiClient, type CommandResult, type CommandValidation } from '../../infrastructure/fuseki.ts';
import { profileRegistry } from '../../../../../packages/model/src/generated/profiles.ts';
import { profileValidations } from '../../infrastructure/profile.ts';
import { assertNotInvalidProfileReceipt, validatedCommand } from '../../infrastructure/invalid-receipt.ts';
import type { ImmutableObjects } from '../../infrastructure/immutable-objects.ts';
import type { RegisteredAdmission } from '../access/admission.ts';
import type { OwnerPartitionRoutes } from '../partition/route.ts';
import { discardUnpublishedWorkObjects, stagedWorkObjectCandidates,
  type StagedWorkObjectCandidates } from './object-gc.ts';
import { readWorkTerminalReceipt, workReceiptIri } from './receipt.ts';
import { workKinds, workSemanticTypes } from './work-kinds.ts';
import { canonicalLanguage } from '../display-language/select.ts';
import { catalogueTitleKey } from '../catalogue-intake/title-keys.ts';
import { workTypeAdmitted } from '../types/registry.ts';

export const RV = 'https://rezics.com/vocab/';
export const ID = 'https://rezics.com/id/';
export const PROFILE = 'https://rezics.com/definition/work-metadata-v1';
export const CONTINUITY = 'https://rezics.com/definition/continuity/native-work-v1';
export const WORK_SEMANTIC_TYPES = workSemanticTypes;
export const MAX_WORK_SEMANTIC_TYPES = 3;
export const DATASET = 'urn:rezics:dataset:product';
// v2 added the public title field; v3 changes the analyzer to cjk-bigram-v2.
export const TEXT_INDEX_PROFILE = 'https://rezics.com/definition/search-index-cjk-bigram-v3';
export const TEXT_INDEX_PROBE_GRAPH = 'urn:rezics:search:probe';
export const TEXT_INDEX_PROBE = 'urn:rezics:search:probe:cjk-bigram-v1';
export const TEXT_INDEX_PROBE_BODY = '中文检索验证 魔法禁書目錄 ガラス ＲＵＳＴ';
export const TEXT_INDEX_PROBE_QUERIES = ['中文检索', '魔法禁书目录', 'がらす', 'ｶﾞﾗｽ', 'rust'] as const;
export const TEXT_INDEX_PROBE_TITLE = '标题检索验证';
/** Constant-size analyzer witness shared by request readiness and rebuild
 * activation. Every query must return the original literal from this graph. */
export function textIndexProbePattern(): string {
  return `GRAPH ${iri(TEXT_INDEX_PROBE_GRAPH)} {
    ${iri(TEXT_INDEX_PROBE)} rv:searchBody ${lit(TEXT_INDEX_PROBE_BODY)}@zh .
    ${TEXT_INDEX_PROBE_QUERIES.map((query, index) => `
      (${iri(TEXT_INDEX_PROBE)} ?probeScore${index} ?probeLiteral${index} ?probeGraph${index})
        text:query (rv:searchBody ${lit(`"${query}"`)} 2) .
      FILTER(?probeLiteral${index} = ${lit(TEXT_INDEX_PROBE_BODY)}@zh
        && ?probeGraph${index} = ${iri(TEXT_INDEX_PROBE_GRAPH)})`).join('\n')}
  }`;
}
export const PUBLIC_SEARCH_ANCHOR = 'urn:rezics:search:public:anchor';
export const GRAPHS = {
  control: 'urn:rezics:graph:control',
  current: 'urn:rezics:graph:current',
  revisions: 'urn:rezics:graph:revisions',
  receipts: 'urn:rezics:graph:receipts',
  outbox: 'urn:rezics:graph:outbox',
} as const;

export interface GraphLineage {
  dataEpoch: string;
  routingEpoch: string;
}

export interface WorkActivationEnvironment {
  /** The owner stages exact slim commands before dispatch and reconciles their commit proofs. */
  receiptCustody?: import('../outbox/receipt-custody.ts').ReceiptCustody;
  addresses?: import('../address/registry.ts').AliasRegistry;
  fuseki: FusekiClient;
  lineage: GraphLineage;
  objectDirectory: string;
  /** Selected for new Work semantic revisions; the directory is the migration baseline. */
  workObjects?: ImmutableObjects;
  /** A worker's lease is checked before dispatch; the graph epoch guards the commit. */
  partitionLease?: { routes: OwnerPartitionRoutes; location: string; leaseEpoch: string };
  /** Target stack's independent title signer, used only by held-owner recovery. */
  titleAdmissionKey?: string;
  /** Kept optional for older integration fixtures; command validation needs no host runtime. */
  candidateDirectory?: string;
  repositoryRoot?: string;
  jenaHome?: string;
  javaHome?: string;
  python?: string;
}

export interface CreateMetadataWorkIntent {
  /** Trusted Access record; never populated from a browser request body. */
  admission: Pick<RegisteredAdmission, 'id' | 'scope' | 'action' | 'idempotencyKey' | 'requestDigest' | 'authorityEpoch' | 'expiresAt'>
    & Partial<Pick<RegisteredAdmission, 'actingSubject'>>;
  title: string;
  language?: string;
  localizedTitle?: { value: string; language: string };
  description?: { value: string; language: string };
  semanticTypes?: readonly string[];
  /** Direct authoring only. Source adoption leaves attribution to source credits. */
  authorAgent?: string;
  /** Intake evidence is separate from the title's authored spelling. */
  catalogue?: { candidateReceipt: string; grain: 'new-creative-scope'; parentComposition?: string;
    aliases?: readonly { value: string; language: string }[];
    romanizations?: readonly { value: string; language: string }[] };
}

export interface WorkActivationReceipt {
  work: string;
  mainVersion: string;
  workRevision: string;
  mainRevision: string;
  receipt: string;
  admissionId: string;
  dataEpoch: string;
  sequence: string;
  replayed: boolean;
}

export class IdempotencyConflict extends Error {}
export class PendingActivation extends Error {}
export class CancelledActivation extends Error {}
export class InvalidWorkSemanticTypes extends Error {}
export class InvalidWorkTitleLanguage extends Error {}
export class AuthorAgentUnavailable extends Error {}

export function hash(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function normalizeWorkSemanticTypes(types: readonly string[] = [], retained = false): string[] {
  if (types.length > MAX_WORK_SEMANTIC_TYPES || new Set(types).size !== types.length
    || types.some(type => !WORK_SEMANTIC_TYPES.includes(type) || !retained && !workTypeAdmitted(type))) {
    throw new InvalidWorkSemanticTypes('invalid Work semantic types');
  }
  return [...types].sort();
}

export function assertNativeWorkTypeCombination(types: readonly string[]): void {
  const interests = new Set(types.map(type => workKinds[type as keyof typeof workKinds].interest).filter(Boolean));
  if (interests.size > 1 || types.includes('https://rezics.com/vocab/SkillPackage')
    && types.includes('https://rezics.com/vocab/PromptTemplate')) {
    throw new InvalidWorkSemanticTypes('conflicting Work semantic types');
  }
}

export function metadataWorkRequestDigest(title: string,
  semanticTypes?: readonly string[], language = 'und',
  details: { localizedTitle?: { value: string; language: string };
    description?: { value: string; language: string }; authorAgent?: string;
    catalogue?: CreateMetadataWorkIntent['catalogue'] } = {}, retained = false): string {
  if (title.length < 1 || title.length > 200 || /[\u0000-\u001f\u007f]/.test(title)) {
    throw new Error('invalid title');
  }
  const types = normalizeWorkSemanticTypes(semanticTypes, retained);
  assertNativeWorkTypeCombination(types);
  const canonical = canonicalLanguage(language);
  if (!canonical || canonical.length > 35) {
    throw new InvalidWorkTitleLanguage('Title language is invalid');
  }
  language = canonical;
  for (const [name, value, maximum] of [['localized title', details.localizedTitle, 500],
    ['description', details.description, 4000]] as const) {
    if (value && (!value.value || value.value.length > maximum || /[\u0000-\u001f\u007f]/.test(value.value)
      || !/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(value.language)
      || value.language.length > 35)) throw new Error(`invalid ${name}`);
  }
  if (details.authorAgent && !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(details.authorAgent)) {
    throw new Error('invalid author Agent');
  }
  if (details.catalogue) {
    const evidence = details.catalogue;
    if (!/^[0-9a-f-]{36}$/.test(evidence.candidateReceipt) || evidence.grain !== 'new-creative-scope'
      || evidence.parentComposition && !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(evidence.parentComposition)) {
      throw new Error('invalid catalogue evidence');
    }
    for (const texts of [evidence.aliases ?? [], evidence.romanizations ?? []]) {
      if (texts.length > 8 || texts.some(text => !canonicalLanguage(text.language) || text.language.length > 35
        || text.value.length < 1 || text.value.length > 500 || /[\u0000-\u001f\u007f]/.test(text.value))) {
        throw new InvalidWorkTitleLanguage('Catalogue title or language is invalid');
      }
    }
  }
  return hash(JSON.stringify({ family: 'create-metadata-work-v1', title, continuity: CONTINUITY,
    ...(language === 'en' ? {} : { language }),
    ...(details.localizedTitle ? { localizedTitle: details.localizedTitle } : {}),
    ...(details.description ? { description: details.description } : {}),
    ...(details.authorAgent ? { authorAgent: details.authorAgent } : {}),
    ...(details.catalogue ? { catalogue: details.catalogue } : {}),
    ...(types.length ? { semanticTypes: types } : {}) }));
}

export function iri(value: string): string {
  if (!/^(?:https:\/\/rezics\.com\/(?:id|definition)\/[A-Za-z0-9._~/-]+|urn:rezics:[A-Za-z0-9:._-]+)$/.test(value)) {
    throw new Error('invalid native IRI');
  }
  return `<${value}>`;
}

export function lit(value: string): string {
  return JSON.stringify(value);
}

function prepareImmutable(directory: string, bytes: Uint8Array): string {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const digest = hash(bytes);
  const target = join(directory, digest);
  if (existsSync(target)) {
    if (hash(readFileSync(target)) !== digest) throw new Error('immutable object collision or corruption');
    return digest;
  }
  const temp = join(directory, `.stage-${Bun.randomUUIDv7()}`);
  const fd = openSync(temp, 'wx', 0o600);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, target);
  if (hash(readFileSync(target)) !== digest) throw new Error('staged immutable object verification failed');
  const dirFd = openSync(directory, 'r');
  try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  return digest;
}

export function prepareComponentWithCandidates(directory: string, component: string, state: object,
  candidates: StagedWorkObjectCandidates, profile = PROFILE): string {
  const payload = Buffer.from(JSON.stringify({ format: 'rezics-component-v1', component, state }));
  const payloadDigest = prepareImmutable(directory, payload);
  candidates.objectDigests.add(payloadDigest);
  const manifest = Buffer.from(JSON.stringify({
    format: 'rezics-manifest-v1', component, payload: `sha256:${payloadDigest}`,
    payloadBytes: payload.length, mediaType: 'application/json', model: profile, shape: profile,
  }));
  const manifestDigest = prepareImmutable(directory, manifest);
  candidates.objectDigests.add(manifestDigest);
  candidates.manifestDigests.add(manifestDigest);
  return manifestDigest;
}

export function prepareComponent(directory: string, component: string, state: object,
  profile = PROFILE): string {
  return prepareComponentWithCandidates(directory, component, state, stagedWorkObjectCandidates(), profile);
}

export async function prepareWorkComponentWithCandidates(objects: ImmutableObjects, component: string,
  state: object, candidates: StagedWorkObjectCandidates, profile = PROFILE): Promise<string> {
  const payload = Buffer.from(JSON.stringify({ format: 'rezics-component-v1', component, state }));
  const payloadDigest = await objects.put(payload);
  candidates.objectDigests.add(payloadDigest);
  const manifest = Buffer.from(JSON.stringify({
    format: 'rezics-manifest-v1', component, payload: `sha256:${payloadDigest}`,
    payloadBytes: payload.length, mediaType: 'application/json', model: profile, shape: profile,
  }));
  const manifestDigest = await objects.put(manifest);
  candidates.objectDigests.add(manifestDigest);
  candidates.manifestDigests.add(manifestDigest);
  return manifestDigest;
}

export async function prepareWorkComponent(objects: ImmutableObjects, component: string, state: object,
  profile = PROFILE): Promise<string> {
  return prepareWorkComponentWithCandidates(objects, component, state, stagedWorkObjectCandidates(), profile);
}

const WORK_PROFILE_ID = 'work-metadata-v1';
const [WORK_SHAPE, MAIN_VERSION_SHAPE] = profileRegistry[WORK_PROFILE_ID].shapes;

export async function workMetadataValidations(env: WorkActivationEnvironment,
  work: string, main: string): Promise<CommandValidation[]> {
  return profileValidations(env.fuseki, WORK_PROFILE_ID, [
    { shape: WORK_SHAPE!, focus: [work], graphs: [GRAPHS.current] },
    { shape: MAIN_VERSION_SHAPE!, focus: [main], graphs: [GRAPHS.current] },
  ]);
}

async function throwAfterStagedCleanup(error: unknown, env: WorkActivationEnvironment,
  candidates: StagedWorkObjectCandidates): Promise<never> {
  try {
    await discardUnpublishedWorkObjects({ fuseki: env.fuseki, objects: env.workObjects,
      objectDirectory: env.objectDirectory, candidates });
  } catch (cleanupError) {
    throw new AggregateError([error, cleanupError],
      'Work activation failed and its staged objects could not be removed');
  }
  throw error;
}

function updateText(env: WorkActivationEnvironment, args: {
  work: string; main: string; workRevision: string; mainRevision: string;
  operation: string; receipt: string; digest: string; title: string; language: string;
  localizedTitle?: { value: string; language: string };
  description?: { value: string; language: string };
  semanticTypes: readonly string[];
  admission: CreateMetadataWorkIntent['admission'];
  workManifest: string; mainManifest: string;
  credit?: { id: string; revision: string; agent: string };
  catalogue?: CreateMetadataWorkIntent['catalogue'];
}): string {
  const g = GRAPHS;
  const outbox = `urn:rezics:outbox:${hash(args.receipt)}`;
  const event = `urn:rezics:event:${hash(args.operation)}`;
  return `PREFIX rv: <${RV}>\nPREFIX schema: <https://schema.org/>\nPREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>\n` +
    `DELETE { GRAPH ${iri(g.control)} { ${iri(DATASET)} rv:sequence ?n } }\n` +
    `INSERT {\n` +
    ` GRAPH ${iri(g.control)} { ${iri(DATASET)} rv:sequence ?next }\n` +
    ` GRAPH ${iri(g.current)} {\n` +
    `  ${iri(args.work)} a schema:CreativeWork${args.semanticTypes.map(type => `, <${type}>`).join('')} ; rv:mainVersion ${iri(args.main)} ; rv:continuityProfile ${iri(CONTINUITY)} ; rdfs:label ${lit(args.title)}@${args.language} ; rv:head ${iri(args.workRevision)} .\n` +
    (args.localizedTitle ? `  ${iri(args.work)} schema:alternateName ${lit(args.localizedTitle.value)}@${args.localizedTitle.language} .\n` : '') +
    (args.description ? `  ${iri(args.work)} schema:description ${lit(args.description.value)}@${args.description.language} .\n` : '') +
    (args.catalogue ? `  ${iri(args.work)} rv:catalogueVisible true ; rv:provisional true ;
      rv:declaredGrain "new-creative-scope" ; rv:candidateSearch ${iri(`urn:rezics:catalogue-search:${args.catalogue.candidateReceipt}`)} ;
      rv:fieldProvenance ${lit(JSON.stringify({ basis: 'creation', revision: args.workRevision,
        contributor: args.admission.actingSubject,
        admission: args.admission.id, candidateReceipt: args.catalogue.candidateReceipt,
        fields: ['title', 'language', 'grain', ...(args.catalogue.parentComposition ? ['parentComposition'] : []),
          ...(args.localizedTitle ? ['localizedTitle'] : []),
          ...(args.description ? ['description'] : []), ...(args.semanticTypes.length ? ['semanticTypes'] : []),
          ...(args.catalogue.aliases?.length ? ['aliases'] : []), ...(args.catalogue.romanizations?.length ? ['romanizations'] : [])] }))} .\n`
      + [...new Set([args.title, ...(args.localizedTitle ? [args.localizedTitle.value] : []),
        ...(args.catalogue.aliases ?? []).map(text => text.value), ...(args.catalogue.romanizations ?? []).map(text => text.value)]
        .map(catalogueTitleKey))].map(key => `  ${iri(args.work)} rv:catalogueTitleKey ${lit(key)} .\n`).join('')
      + [...(args.catalogue.aliases ?? []), ...(args.catalogue.romanizations ?? [])]
        .map(title => `  ${iri(args.work)} schema:alternateName ${lit(title.value)}@${canonicalLanguage(title.language)} .\n`).join('')
      + (args.catalogue.parentComposition ? `  ${iri(args.work)} rv:declaredParentComposition ${iri(args.catalogue.parentComposition)} .\n` : '') : '') +
    (args.credit ? `  ${iri(args.credit.id)} a rv:NativeAgentCredit ; rv:creditRevision ${iri(args.credit.revision)} ; rv:work ${iri(args.work)} ; rv:agent ${iri(args.credit.agent)} ; schema:roleName "author" .\n` : '') +
    `  ${iri(args.main)} a rv:MainVersion ; rv:work ${iri(args.work)} ; rv:hostingPolicy rv:MetadataOnly ; rv:head ${iri(args.mainRevision)} .\n` +
    ` }\n` +
    ` GRAPH ${iri(g.revisions)} {\n` +
    `  ${iri(args.workRevision)} a rv:RevisionAnchor ; rv:component ${iri(args.work)} ; rv:operation ${iri(args.operation)} ; rv:manifest ${iri(`urn:rezics:sha256:${args.workManifest}`)} ; rv:modelRevision ${iri(PROFILE)} ; rv:shapeRevision ${iri(PROFILE)} ; rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next .\n` +
    `  ${iri(args.mainRevision)} a rv:RevisionAnchor ; rv:component ${iri(args.main)} ; rv:operation ${iri(args.operation)} ; rv:manifest ${iri(`urn:rezics:sha256:${args.mainManifest}`)} ; rv:modelRevision ${iri(PROFILE)} ; rv:shapeRevision ${iri(PROFILE)} ; rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next .\n` +
    (args.credit ? `  ${iri(args.credit.revision)} a rv:NativeAgentCreditRevision, rv:RevisionAnchor ; rv:component ${iri(args.credit.id)} ; rv:work ${iri(args.work)} ; rv:agent ${iri(args.credit.agent)} ; schema:roleName "author" ; rv:workRevision ${iri(args.workRevision)} ; rv:modelRevision <https://rezics.com/definition/native-agent-credit-v1> ; rv:shapeRevision <https://rezics.com/definition/native-agent-credit-v1> ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next .\n` : '') +
    ` }\n` +
    ` GRAPH ${iri(g.receipts)} { ${iri(args.receipt)} a rv:OperationReceipt ; rv:operation ${iri(args.operation)} ; rv:requestDigest ${lit(args.digest)} ; rv:admissionId ${lit(args.admission.id)} ; rv:authorityEpoch ${lit(args.admission.authorityEpoch)} ; rv:admittedScope ${lit(args.admission.scope)} ; rv:outcome rv:Succeeded ; rv:work ${iri(args.work)} ; rv:mainVersion ${iri(args.main)} ; rv:workRevision ${iri(args.workRevision)} ; rv:mainRevision ${iri(args.mainRevision)} ; rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next . }\n` +
    ` GRAPH ${iri(g.outbox)} { ${iri(outbox)} a rv:OutboxBatch ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next ; rv:eventCount 1 ; rv:event ${iri(event)} . ${iri(event)} a rv:WorkCreatedEvent ; rv:ordinal 0 ; rv:action "work.create" ; rv:receipt ${iri(args.receipt)} ; rv:operation ${iri(args.operation)} ; rv:work ${iri(args.work)} . }\n` +
    `}\nWHERE {\n` +
    ` GRAPH ${iri(g.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n ; rv:modelHead ${iri(PROFILE)} ; rv:shapeHead ${iri(PROFILE)} . }\n` +
    ` FILTER NOT EXISTS { GRAPH ${iri(g.control)} { ${iri(DATASET)} rv:restoreHold true } }\n` +
    ` FILTER NOT EXISTS { GRAPH ${iri(g.receipts)} { ${iri(args.receipt)} ?p ?o } }\n` +
    ` FILTER NOT EXISTS { GRAPH ${iri(g.current)} { ${iri(args.work)} ?wp ?wo } }\n` +
    ` FILTER NOT EXISTS { GRAPH ${iri(g.current)} { ${iri(args.main)} ?mp ?mo } }\n` +
    (args.credit ? ` GRAPH ${iri(g.current)} { ${iri(args.credit.agent)} a rv:Agent . }\n` : '') +
    ` BIND(?n + 1 AS ?next)\n}`;
}

export async function activateMetadataWork(env: WorkActivationEnvironment, intent: CreateMetadataWorkIntent): Promise<WorkActivationReceipt> {
  const admission = intent.admission;
  if (intent.authorAgent && intent.authorAgent !== admission.actingSubject) {
    throw new Error('author Agent differs from admitted acting subject');
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(admission.id)
    || !/^[A-Za-z0-9:_./-]{1,128}$/.test(admission.scope)
    || !/^[A-Za-z0-9:_./-]{1,128}$/.test(admission.idempotencyKey)
    || !/^[0-9]+$/.test(admission.authorityEpoch)
    || admission.action !== 'work.create') {
    throw new Error('invalid Work admission');
  }
  const semanticTypes = normalizeWorkSemanticTypes(intent.semanticTypes, true);
  // A missing declaration records an undetermined language; no interface locale
  // can supply the authored title's language.
  const digest = metadataWorkRequestDigest(intent.title, semanticTypes, intent.language, intent, true);
  const language = canonicalLanguage(intent.language ?? 'und')!;
  const receipt = workReceiptIri(admission.id);
  await assertNotInvalidProfileReceipt(env.fuseki, workReceiptIri(admission.id));
  const existing = await readWorkTerminalReceipt(env.fuseki, admission.id);
  if (existing) {
    // A language-omitting legacy admission meant English. Replay its recorded
    // receipt, while every new omitted-language activation still writes und.
    const replayDigest = intent.language === undefined && existing.requestDigest ===
      metadataWorkRequestDigest(intent.title, semanticTypes, 'en', intent, true) ? existing.requestDigest : digest;
    if (admission.requestDigest !== replayDigest || existing.requestDigest !== replayDigest || existing.admissionId !== admission.id
      || existing.authorityEpoch !== admission.authorityEpoch || existing.scope !== admission.scope) {
      throw new IdempotencyConflict('admission does not match stored receipt');
    }
    if (existing.outcome === 'cancelled') throw new CancelledActivation('Work admission was sealed as cancelled');
    return { work: existing.work!, mainVersion: existing.mainVersion!,
      workRevision: existing.workRevision!, mainRevision: existing.mainRevision!, receipt, admissionId: admission.id,
      dataEpoch: existing.dataEpoch, sequence: existing.sequence, replayed: true };
  }
  if (admission.requestDigest !== digest) throw new IdempotencyConflict('admission digest does not match Work intent');
  // Retained membership proves retries; only an active type can produce a new Work.
  normalizeWorkSemanticTypes(semanticTypes);
  if (!Number.isFinite(Date.parse(admission.expiresAt)) || Date.parse(admission.expiresAt) <= Date.now()) {
    throw new PendingActivation('admission expired before dispatch');
  }
  const assertPartition = () => env.partitionLease?.routes.assertWrite({ owner: 'graph',
    datasetId: DATASET, location: env.partitionLease.location,
    routingEpoch: env.lineage.routingEpoch, leaseEpoch: env.partitionLease.leaseEpoch });
  await assertPartition();
  const work = ID + Bun.randomUUIDv7();
  const main = ID + Bun.randomUUIDv7();
  const workRevision = ID + Bun.randomUUIDv7();
  const mainRevision = ID + Bun.randomUUIDv7();
  const operation = ID + Bun.randomUUIDv7();
  // An explicit own-work request must commit its author credit with the Work.
  const authorReady = intent.authorAgent ? (await env.fuseki.query(`PREFIX rv: <${RV}> ASK {
    GRAPH ${iri(GRAPHS.current)} { ${iri(intent.authorAgent)} a rv:Agent ; rv:head ?head . }
    GRAPH ${iri(GRAPHS.revisions)} { ?head a rv:RevisionAnchor ;
      rv:component ${iri(intent.authorAgent)} . } }`)).boolean === true : false;
  if (intent.authorAgent && !authorReady) throw new AuthorAgentUnavailable('Author Agent graph is unavailable');
  const credit = authorReady && intent.authorAgent ? { id: ID + Bun.randomUUIDv7(),
    revision: ID + Bun.randomUUIDv7(), agent: intent.authorAgent } : undefined;
  const validations = [...await workMetadataValidations(env, work, main),
    ...await profileValidations(env.fuseki, 'work-kind-v3', [
      { shape: profileRegistry['work-kind-v3'].shapes[0]!, focus: [work], graphs: [GRAPHS.current] },
    ]), ...(credit ? await profileValidations(env.fuseki, 'native-agent-credit-v1', [
      { shape: 'https://rezics.com/definition/native-agent-credit-v1/credit-shape',
        focus: [credit.id], graphs: [GRAPHS.current, GRAPHS.revisions] },
      { shape: 'https://rezics.com/definition/native-agent-credit-v1/revision-shape',
        focus: [credit.revision], graphs: [GRAPHS.current, GRAPHS.revisions] },
    ]) : [])];
  const workState = { mainVersion: main, continuityProfile: CONTINUITY, title: intent.title,
    language, ...(intent.localizedTitle ? { localizedTitle: intent.localizedTitle } : {}),
    ...(intent.description ? { description: intent.description } : {}),
    ...(semanticTypes.length ? { semanticTypes } : {}), ...(intent.catalogue ? { catalogue: intent.catalogue } : {}) };
  const mainState = { work, hostingPolicy: 'metadata-only' };
  const candidates = stagedWorkObjectCandidates();
  let workManifest: string;
  let mainManifest: string;
  try {
    workManifest = env.workObjects
      ? await prepareWorkComponentWithCandidates(env.workObjects, work, workState, candidates)
      : prepareComponentWithCandidates(env.objectDirectory, work, workState, candidates);
    mainManifest = env.workObjects
      ? await prepareWorkComponentWithCandidates(env.workObjects, main, mainState, candidates)
      : prepareComponentWithCandidates(env.objectDirectory, main, mainState, candidates);
  } catch (error) {
    if (candidates.objectDigests.size) await throwAfterStagedCleanup(error, env, candidates);
    throw error;
  }
  if (Date.parse(admission.expiresAt) <= Date.now()) {
    await throwAfterStagedCleanup(new PendingActivation('admission expired before graph update'), env, candidates);
  }
  try { await assertPartition(); }
  catch (error) { await throwAfterStagedCleanup(error, env, candidates); }
  let updateError: unknown;
  let commandResult: CommandResult | undefined;
  try {
    commandResult = await validatedCommand(env, { receipt, digest,
      update: updateText(env, { work, main, workRevision, mainRevision, operation, receipt,
        digest, title: intent.title, language, localizedTitle: intent.localizedTitle,
        description: intent.description, semanticTypes, admission, workManifest, mainManifest, credit,
        catalogue: intent.catalogue }),
      validations, deadlineMs: 10_000 }, admission);
    if (commandResult.status === 'invalid' || commandResult.status === 'unknown-profile'
      || commandResult.status === 'conflict') throw new CommandRejected(commandResult);
  } catch (error) {
    if (error instanceof CommandRejected) await throwAfterStagedCleanup(error, env, candidates);
    updateError = error;
  }
  const committed = await readWorkTerminalReceipt(env.fuseki, admission.id);
  if (committed) {
    if (committed.requestDigest !== digest || committed.admissionId !== admission.id
      || committed.authorityEpoch !== admission.authorityEpoch || committed.scope !== admission.scope) {
      throw new IdempotencyConflict('admission does not match stored receipt');
    }
    if (committed.outcome === 'cancelled') {
      await discardUnpublishedWorkObjects({ fuseki: env.fuseki, objects: env.workObjects,
        objectDirectory: env.objectDirectory, candidates });
      throw new CancelledActivation('Work admission was sealed as cancelled');
    }
    if (committed.work !== work) {
      await discardUnpublishedWorkObjects({ fuseki: env.fuseki, objects: env.workObjects,
        objectDirectory: env.objectDirectory, candidates });
    }
    return { work: committed.work!, mainVersion: committed.mainVersion!,
      workRevision: committed.workRevision!, mainRevision: committed.mainRevision!, receipt, admissionId: admission.id,
      dataEpoch: committed.dataEpoch, sequence: committed.sequence, replayed: committed.work !== work };
  }
  if (!updateError && commandResult?.status === 'guard-unmatched') {
    await throwAfterStagedCleanup(new PendingActivation('guard did not match; no receipt committed'), env, candidates);
  }
  throw new PendingActivation(updateError ? 'write outcome unknown; receipt absent after update error' : 'guard did not match; no receipt committed');
}

/** Privileged fresh-dataset bootstrap. Never exposed through a product route. */
export async function initializeFreshGraph(fuseki: FusekiClient, lineage: GraphLineage): Promise<void> {
  const generation = `urn:rezics:text-index-generation:${Bun.randomUUIDv7()}`;
  const receipt = `urn:rezics:receipt:bootstrap:${hash(`${lineage.dataEpoch}\0${lineage.routingEpoch}`)}`;
  const digest = hash(JSON.stringify({ family: 'bootstrap-graph-v1', lineage }));
  const update = `PREFIX rv: <${RV}> INSERT { GRAPH ${iri(GRAPHS.control)} {
    ${iri(DATASET)} rv:dataEpoch ${lit(lineage.dataEpoch)} ; rv:routingEpoch ${lit(lineage.routingEpoch)} ;
      rv:sequence 0 ; rv:modelHead ${iri(PROFILE)} ; rv:shapeHead ${iri(PROFILE)} ;
      rv:textIndexProfile ${iri(TEXT_INDEX_PROFILE)} ;
      rv:textIndexGeneration ${iri(generation)} .
  } GRAPH <urn:rezics:search:public> {
    ${iri(PUBLIC_SEARCH_ANCHOR)} a rv:SearchGraphAnchor .
  } GRAPH ${iri(TEXT_INDEX_PROBE_GRAPH)} {
    ${iri(TEXT_INDEX_PROBE)} rv:searchBody ${lit(TEXT_INDEX_PROBE_BODY)}@zh ;
      rv:publicTitle ${lit(TEXT_INDEX_PROBE_TITLE)}@en .
  } GRAPH ${iri(GRAPHS.receipts)} {
    ${iri(receipt)} a rv:OperationReceipt ; rv:requestDigest ${lit(digest)} ;
      rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(lineage.dataEpoch)} ; rv:sequence 0 .
  } } WHERE { FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} ?p ?o } }
    FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } } }`;
  const command = await fuseki.commandWithReceipt({ receipt, digest, update,
    validations: [], deadlineMs: 10_000 });
  if (command.status !== 'committed') throw new CommandRejected(command);
  const result = await fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH ${iri(GRAPHS.control)} {
    ${iri(DATASET)} rv:dataEpoch ${lit(lineage.dataEpoch)} ; rv:routingEpoch ${lit(lineage.routingEpoch)} ;
      rv:sequence 0 ; rv:modelHead ${iri(PROFILE)} ; rv:shapeHead ${iri(PROFILE)} ;
      rv:textIndexProfile ${iri(TEXT_INDEX_PROFILE)} ; rv:textIndexGeneration ?generation .
  } GRAPH <urn:rezics:search:public> {
    ${iri(PUBLIC_SEARCH_ANCHOR)} a rv:SearchGraphAnchor .
  } GRAPH ${iri(TEXT_INDEX_PROBE_GRAPH)} {
    ${iri(TEXT_INDEX_PROBE)} rv:searchBody ${lit(TEXT_INDEX_PROBE_BODY)}@zh ;
      rv:publicTitle ${lit(TEXT_INDEX_PROBE_TITLE)}@en .
  } }`);
  if (result.boolean !== true) throw new Error('dataset control already initialized or invalid');
}
