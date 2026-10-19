import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync,
  renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { FixtureWorkBudget } from '../../fixture/budget.ts';
import { sha256, stable } from '../../fixture/corpus.ts';
import { isRetainedJson, type RetainedJson, type RetainedOwnerState } from '../../fixture/manifest.ts';
import { canonicalJson } from '../../lib/canonical-json.ts';
import { classicText } from '../../dev/seed/classics-text.ts';
import { gutenbergBooks } from '../../../tests/fixtures/sources/gutenberg.ts';
import { loadCompatibility } from '../../load/compatibility.ts';
import { readSnapshot, verifySnapshot } from '../../datasets/snapshot.ts';
import { blobPath, verifiedBlob } from '../../datasets/store.ts';
import { datasetMediaMapper } from '../../datasets/native/media.ts';
import { datasetIntakeReceipt } from '../../datasets/native/context.ts';
import { selectDatasetRoots, type DatasetSelectionResult } from '../../datasets/selection.ts';
import type { DatasetIntakeCommand, DatasetIntakeCoordinate, DatasetNativeMapper, DatasetSnapshot } from '../../datasets/types.ts';
import { reconstructIntake } from '../../datasets/import.ts';
import { RetainedSources, sourceFileDigests, sourceKey, type RetainedSourceAdapter,
  type RetainedSourceManifest, type SourceContext, type SourceInputs } from '../retained-source.ts';
import matrix from '../../../tests/qa/fixtures/catalogue/import-outcomes.json';
import { retainedAdmissionCases, type RetainedRecordInput } from '../../../tests/qa/fixtures/catalogue/import-admission-contract.ts';
import { informationMatrix } from '../../../tests/qa/fixtures/catalogue-information-matrix.ts';
import { assertPublicDomainNativeCreation, publicDomainBaseline } from '../../../tests/qa/fixtures/catalogue-public-domain.ts';
import { auditBaseline, auditConsumerForFile, auditConsumers, auditOwnerPrerequisites,
  auditPreparationBudgetMs, type AuditCommand, type AuditCommandReceipt, type AuditConsumer,
  type AuditFilePin, type AuditGrantReceipt, type AuditImport, type AuditManifests, type AuditOriginals, type AuditPreparationMetadata,
  type AuditReadPredicate, type AuditRecipe, type AuditValue } from '../../../tests/qa/fixtures/audit-corpus-contract.ts';
import type { PersonaName, RetainedPersonaRealm } from '../../../tests/qa/support/personas.ts';
import { tryAcquireDirectoryLease } from '../process/lease.ts';

export { auditConsumers, auditOwnerPrerequisites };
export { auditProofFiles } from '../../../tests/qa/fixtures/audit-corpus-contract.ts';
const root = resolve(import.meta.dir, '../../..');
const native = /^https:\/\/rezics\.com\/id\/[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const hex = /^[a-f0-9]{64}$/;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = (value: unknown) => sha256(canonicalJson(value));
function requireFact(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Audit preparation: ${message}`);
}
function json(value: unknown): RetainedJson {
  requireFact(isRetainedJson(value), 'owner result is not finite JSON');
  return value;
}
function jsonObject(value: unknown): Record<string, RetainedJson> {
  requireFact(object(value) && isRetainedJson(value), 'expected a finite JSON object');
  return value as Record<string, RetainedJson>;
}

export class AuditCorpusBlocked extends Error {
  readonly classification = 'preparation-blocked';
  readonly assertionsReached = false;
  constructor(readonly owner: string, readonly stage: string, detail: string) {
    super(`${owner} [${stage}]: ${detail}`);
  }
}

/** A fixture from a later product tree cannot stand in for the original audit
 * baseline. Leave the independent consumer premises unchanged and refuse it. */
export function auditBaselineBlockers(pins: Readonly<Record<string, string>> = {
  imports: matrix.baselineProduct,
  information: informationMatrix.baselineProduct,
  publicDomain: publicDomainBaseline,
}): AuditInspection['blockers'] {
  return Object.entries(pins).filter(([, revision]) => revision !== auditBaseline)
    .map(([consumer, revision]) => ({ owner: 'audit-baseline-contract', stage: consumer,
      detail: `consumer pins ${revision}; original product baseline is ${auditBaseline}; an owner must establish a compatible fixture/test overlay without advancing that baseline` }));
}

export function auditProductBlockers(productRevision: string | undefined, current: string): AuditInspection['blockers'] {
  if (productRevision === undefined) return auditBaselineBlockers();
  return productRevision === current ? [] : [{ owner: 'audit-product-revision', stage: 'product-pin',
    detail: `recipe pins ${productRevision}; current executable product is ${current}; do not relabel either revision` }];
}

/** Check the retained owner's declared mode before restore/startup can write. */
export function assertAuditStorage(compose: Readonly<Record<string, string>>): void {
  if (compose.REZICS_STACK_STORAGE !== 'persistent' || compose.REZICS_STACK_RAW_UPDATE !== '0')
    throw new AuditCorpusBlocked('catalogue-backup', 'before-restore-storage',
      'retained source must declare persistent storage and REZICS_STACK_RAW_UPDATE=0 before any writer starts');
}

export function auditSelectionBlockers(input: AuditImport, selection: DatasetSelectionResult): AuditInspection['blockers'] {
  // The importer retains missing-media dispositions. Intake-only execution can
  // preserve that truthful incompleteness without claiming catalogue readiness.
  if (selection.status === 'complete' || input.native === false && selection.status === 'incomplete'
    && selection.manifest.coverage.knowledge === 'complete'
    && selection.manifest.limitations.every(item => item.affects === 'media')) return [];
  return [{ owner: 'dataset-selection', stage: input.snapshot,
    detail: `bounded closure ${selection.status}; ${selection.manifest.limitations.map(item => item.code).join(', ')}` }];
}

/** Resolve existing files through realpath before reading; even read-only inputs
 * cannot borrow another worker's credentials or source corpus via a symlink. */
export function auditLocalFile(checkout: string, path: string, temporaryOnly = true): string {
  const base = realpathSync(checkout), actual = realpathSync(resolve(checkout, path));
  const name = relative(base, actual);
  requireFact(name && !isAbsolute(name) && name !== '..' && !name.startsWith(`..${sep}`), 'file escapes this worktree');
  requireFact(name.startsWith(`.temp${sep}`) || !temporaryOnly && name.startsWith(`tests${sep}fixtures${sep}`),
    'fixture input must be in .temp (retained source evidence may also use tests/fixtures)');
  return actual;
}
function pinnedBytes(checkout: string, pin: { file: string; sha256: string }, temporaryOnly = true): Buffer {
  requireFact(object(pin) && typeof pin.file === 'string' && hex.test(pin.sha256), 'invalid file pin');
  const bytes = readFileSync(auditLocalFile(checkout, pin.file, temporaryOnly));
  requireFact(sha256(bytes) === pin.sha256, `file digest differs: ${pin.file}`);
  return bytes;
}

/** RFC6901; missing and explicitly null have different results. Own properties
 * only, including numeric array positions. Root selection is explicit. */
export function auditPointer(value: unknown, pointer: string): unknown {
  requireFact(typeof pointer === 'string' && (pointer === '' || pointer.startsWith('/')), 'invalid JSON pointer');
  if (!pointer) return value;
  for (const token of pointer.slice(1).split('/')) {
    requireFact(!/~(?:[^01]|$)/u.test(token), 'invalid JSON pointer escape');
    const key = token.replaceAll('~1', '/').replaceAll('~0', '~');
    requireFact(value !== null && typeof value === 'object' && Object.hasOwn(value, key), `missing JSON pointer ${pointer}`);
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

export function resolveAuditValue(value: AuditValue, bindings: ReadonlyMap<string, RetainedJson>): RetainedJson {
  if (Array.isArray(value)) return value.map(item => resolveAuditValue(item, bindings));
  if (!object(value)) return json(value);
  if (Object.hasOwn(value, '$audit')) {
    if (value.$audit === 'ref') {
      requireFact(Object.keys(value).sort().join(',') === '$audit,from,pointer' && typeof value.from === 'string'
        && typeof value.pointer === 'string', 'malformed receipt reference');
      requireFact(bindings.has(value.from), `unobserved binding ${value.from}`);
      return json(auditPointer(bindings.get(value.from), value.pointer));
    }
    if (value.$audit === 'concat') {
      requireFact(Object.keys(value).sort().join(',') === '$audit,values' && Array.isArray(value.values), 'malformed path concatenation');
      return value.values.map(item => {
        const part = resolveAuditValue(item, bindings);
        requireFact(typeof part === 'string', 'path component is not a string');
        return part;
      }).join('');
    }
    if (value.$audit === 'tail') {
      requireFact(Object.keys(value).sort().join(',') === '$audit,value', 'malformed native short ID');
      const id = resolveAuditValue(value.value!, bindings);
      requireFact(typeof id === 'string' && native.test(id), 'short ID requires an observed native IRI');
      return id.slice(-36);
    }
    if (value.$audit === 'intakes') {
      requireFact(Object.keys(value).sort().join(',') === '$audit,from,pointer'
        && typeof value.from === 'string' && value.from.startsWith('import:')
        && typeof value.pointer === 'string' && bindings.has(value.from), 'unobserved importer intake projection');
      const parts = auditPointer(bindings.get(value.from), value.pointer);
      requireFact(Array.isArray(parts) && parts.length > 0, 'importer intake projection has no actual parts');
      return parts.map((part: unknown, index: number) => {
        requireFact(object(part) && object(part.command), 'importer intake projection lacks command custody');
        const command = part.command as unknown as DatasetIntakeCommand;
        requireFact(command.coordinate?.purpose === 'record' && command.coordinate.index === index && command.coordinate.count === parts.length
          && command.responses.some(reply => [200, 201].includes(reply.status ?? 0) && hash(reply.body) === hash(command.result)),
        'importer intake projection lacks an ordered successful response');
        const receipt = datasetIntakeReceipt(command, command.request);
        requireFact(['index', 'record', 'observation', 'byteDigest', 'byteLength'].every(key => part[key] === receipt[key as keyof typeof receipt]),
          'importer intake projection differs from its actual acknowledgement');
        return { index, record: receipt.record, observation: receipt.observation, byteDigest: receipt.byteDigest };
      });
    }
    throw new Error('Audit preparation: unknown template operation');
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveAuditValue(item, bindings)]));
}

export function assertAuditRecipe(value: unknown): asserts value is AuditRecipe {
  requireFact(object(value) && value.format === 'audit-corpus-recipe-v1', 'recipe format differs');
  for (const key of ['imports', 'evidence', 'realms', 'grants', 'stages', 'readiness'])
    requireFact(Array.isArray(value[key]), `recipe ${key} is not an array`);
  requireFact(typeof value.sourceRoot === 'string' && object(value.originals) && object(value.manifests), 'recipe source/bindings/projections are missing');
  requireFact(Object.keys(value.manifests).sort().join() === Object.keys(auditConsumers).sort().join(), 'provide exactly one projection for each existing consumer');
  const recipe = value as unknown as AuditRecipe;
  requireFact(recipe.productRevision === undefined || /^[a-f0-9]{40}$/u.test(recipe.productRevision), 'invalid current product pin');
  requireFact(recipe.inputPreparationMs === undefined || Number.isFinite(recipe.inputPreparationMs)
    && recipe.inputPreparationMs >= 0, 'invalid earlier input preparation duration');
  for (const input of recipe.imports) requireFact(input.native === undefined || typeof input.native === 'boolean', 'invalid native import mode');
  requireFact(recipe.unknownControls === undefined || Array.isArray(recipe.unknownControls)
    && recipe.unknownControls.every(name => /^[a-z][a-z0-9-]*$/u.test(name))
    && new Set(recipe.unknownControls).size === recipe.unknownControls.length, 'invalid unknown control names');
  const realms = new Set<string>(), evidence = new Set<string>(), stages = new Set<string>(), commands = new Set<string>(), keys = new Set<string>();
  for (const realm of recipe.realms) {
    requireFact(/^[a-z][a-z0-9-]*$/.test(realm.id) && !realms.has(realm.id) && ['public', 'private'].includes(realm.visibility), 'invalid or duplicate realm');
    realms.add(realm.id);
  }
  requireFact(recipe.realms.some(realm => realm.visibility === 'private') && recipe.realms.filter(realm => realm.visibility === 'public').length >= 2,
    'public, private and independent-author realms are required');
  requireFact(realms.has(recipe.emptyIdentityRealm), 'Account-only identity stage needs a retained realm');
  for (const item of recipe.evidence) {
    requireFact(typeof item.id === 'string' && !evidence.has(item.id) && hex.test(item.sha256), 'invalid or duplicate evidence pin');
    requireFact(['record', 'text', 'media', 'original'].includes(item.kind), 'unrecognized source qualification');
    evidence.add(item.id);
  }
  for (const stage of recipe.stages) {
    requireFact(/^[a-z][a-z0-9-]*$/.test(stage.id) && !stages.has(stage.id), 'invalid or duplicate stage');
    requireFact(Array.isArray(stage.requires) && stage.requires.every(id => stages.has(id)), 'stage dependency is missing or out of order');
    stages.add(stage.id);
    requireFact(Array.isArray(stage.commands), 'stage commands are missing');
    for (const command of stage.commands) {
      requireFact(/^[a-z][a-z0-9-]*$/.test(command.id) && !commands.has(command.id), 'invalid or duplicate command');
      requireFact(realms.has(command.realm) && ['stranger', 'member', 'owner', 'moderator', 'operator'].includes(command.persona), 'command persona is missing');
      requireFact(['GET', 'POST', 'PUT', 'PATCH'].includes(command.method) && Number.isInteger(command.status)
        && command.status >= 200 && command.status < 300, 'preparation commands must observe successful public API results');
      requireFact(command.method === 'GET' ? command.key === null : typeof command.key === 'string' && command.key.length > 0 && !keys.has(command.key),
        'mutation requires a distinct retained replay key; reads use no key');
      requireFact(Array.isArray(command.evidence) && (command.method === 'GET' || command.evidence.length > 0)
        && command.evidence.every(id => evidence.has(id)), 'mutation lacks qualified source evidence');
      commands.add(command.id);
      if (command.key) keys.add(command.key);
    }
  }
  requireFact(recipe.readiness.length > 0 && recipe.readiness.some(item => item.persona === 'visitor' && item.status === 200)
    && recipe.readiness.some(item => item.persona === 'visitor' && item.status === 404), 'public and concealed readiness controls are required');
  const reads = new Set<string>();
  for (const read of recipe.readiness) {
    requireFact(typeof read.id === 'string' && !reads.has(read.id) && realms.has(read.realm)
      && ['visitor', 'stranger', 'member', 'owner', 'moderator', 'operator'].includes(read.persona)
      && [200, 404].includes(read.status) && object(read.equals) && Object.keys(read.equals).length > 0, 'invalid read-ready predicate');
    reads.add(read.id);
  }
  for (const grant of recipe.grants) requireFact(realms.has(grant.realm)
    && ['stranger', 'member', 'owner', 'moderator', 'operator'].includes(grant.persona)
    && typeof grant.scope === 'string' && typeof grant.action === 'string'
    && ['8 hours', '7 days'].includes(grant.lifetime), 'invalid supported fixture authority input');
  requireFact(recipe.grants.some(grant => grant.persona === 'operator' && grant.scope === 'work:create:catalogue-import' && grant.action === 'work.create'),
    'platform catalogue import mandate is not established by an operator label');
}

export interface AuditInspection {
  recipe: AuditRecipe; recipePin: { file: string; sha256: string }; originals: AuditOriginals;
  snapshots: Map<string, DatasetSnapshot>; selections: Map<string, DatasetSelectionResult>;
  sourcePins: Array<{ file: string; sha256: string }>;
  blockers: Array<{ owner: string; stage: string; detail: string }>;
  inspectionMs: number;
}

function assertRetainedRealm(value: unknown): asserts value is RetainedPersonaRealm {
  requireFact(object(value) && ['realm', 'space', 'zone'].every(key => typeof value[key] === 'string' && native.test(value[key]))
    && ['public', 'private'].includes(String(value.visibility)) && object(value.identities) && object(value.auth),
  'retained persona realm is missing its original identity/auth bindings');
  const identities = value.identities, auth = value.auth;
  for (const persona of ['stranger', 'member', 'owner', 'moderator', 'operator']) {
    const person = identities[persona];
    requireFact(object(person) && ['email', 'password', 'accountId'].every(key => typeof person[key] === 'string' && person[key].length > 0)
      && typeof person.actingSubject === 'string' && native.test(person.actingSubject), 'retained persona identity is incomplete');
  }
  requireFact(['accountOrigin', 'clientId', 'scope', 'mainClientId', 'mainClientSecret'].every(key => typeof auth[key] === 'string' && auth[key].length > 0)
    && Array.isArray(auth.redirectUris) && auth.redirectUris.length > 0
    && auth.redirectUris.every(uri => typeof uri === 'string'), 'retained OAuth bindings are incomplete');
}

export function assertAuditOriginals(value: unknown): asserts value is AuditOriginals {
  requireFact(object(value) && value.format === 'audit-original-bindings-v1' && Array.isArray(value.bindings) && value.bindings.length === 113,
    'all 113 original native Work bindings are required');
  assertRetainedRealm(value.personas);
  requireFact(object(value.backup) && typeof value.backup.file === 'string' && hex.test(String(value.backup.sha256)), 'original stopped backup pin is missing');
  const originals = value as unknown as AuditOriginals;
  for (const key of ['sourceKey', 'resource', 'mainVersion'] as const)
    requireFact(new Set(originals.bindings.map(binding => binding[key])).size === 113, `original ${key} binding is duplicated`);
  for (const binding of originals.bindings) requireFact(binding.sourceKey && native.test(binding.resource) && native.test(binding.mainVersion)
    && native.test(binding.revision) && typeof binding.readPath === 'string'
    && [binding.resourcePointer, binding.mainVersionPointer, binding.revisionPointer].every(pointer => typeof pointer === 'string' && pointer.startsWith('/')),
  'original native identity/revision is not exact');
}

/** Entirely offline. No fallback capture, refresh, latest pin or prefix selection. */
export function inspectAuditRecipe(checkout: string, path: string, availableMappers?: readonly DatasetNativeMapper[]): AuditInspection {
  const inspectionStarted = Date.now();
  const file = auditLocalFile(checkout, path), bytes = readFileSync(file), recipe: unknown = JSON.parse(bytes.toString());
  assertAuditRecipe(recipe);
  const mappers = availableMappers ?? [datasetMediaMapper(resolve(checkout, recipe.sourceRoot))];
  const originals: unknown = JSON.parse(pinnedBytes(checkout, recipe.originals).toString());
  assertAuditOriginals(originals);
  pinnedBytes(checkout, originals.backup);
  const sourceRoot = auditLocalFile(checkout, recipe.sourceRoot);
  const sourcePins = [recipe.originals, originals.backup], snapshots = new Map<string, DatasetSnapshot>();
  for (const pin of matrix.sources) {
    const snapshotFile = join(sourceRoot, 'snapshots', pin.id, 'snapshot.json');
    pinnedBytes(checkout, { file: snapshotFile, sha256: pin.fileSha256 });
    const snapshot = readSnapshot(sourceRoot, pin.id);
    verifySnapshot(sourceRoot, snapshot);
    requireFact(snapshot.digest === pin.digest && snapshot.createdAt === pin.createdAt, `frozen snapshot identity differs: ${pin.id}`);
    const records = snapshot.sources.flatMap(source => source.records), byKey = new Map(records.map(record => [record.key, record]));
    requireFact(records.length === byKey.size && records.length - pin.recordKeys.length === pin.excludedRecordCount, 'frozen record closure differs');
    for (const [key, digest] of Object.entries(pin.recordDigests)) requireFact(byKey.has(key) && hash(byKey.get(key)) === digest, `frozen record changed: ${key}`);
    const frozenSource = snapshot.sources.find(source => source.provider === pin.provider);
    requireFact(frozenSource, `frozen provider is absent: ${pin.provider}`);
    const edges = pin.edgeIndexes.map(index => frozenSource.edges[index]);
    requireFact(edges.every(edge => edge && pin.recordKeys.includes(edge.from) && pin.recordKeys.includes(edge.to)), 'frozen edge endpoints leave elected closure');
    requireFact(edges.length === pin.edgeCount && hash(edges) === pin.edgeDigest, `frozen edge occurrence/qualification differs: ${pin.id}`);
    snapshots.set(pin.id, snapshot);
    sourcePins.push({ file: snapshotFile, sha256: pin.fileSha256 });
  }
  const evidenceById = new Map(recipe.evidence.map(item => [item.id, item]));
  for (const item of recipe.evidence) {
    const evidenceBytes = pinnedBytes(checkout, item, false);
    sourcePins.push({ file: item.file, sha256: item.sha256 });
    if (item.kind === 'record') {
      const source = snapshots.get(item.snapshot)?.sources.flatMap(part => part.records).find(record => record.key === item.sourceKey);
      requireFact(source && hash(source) === item.recordDigest && hash(JSON.parse(evidenceBytes.toString())) === item.recordDigest,
        `record evidence is not the original qualified record: ${item.id}`);
      auditPointer(source, item.pointer);
    } else if (item.kind === 'text' || item.kind === 'original') {
      requireFact(typeof item.exact === 'string' && item.exact.length > 0 && evidenceBytes.toString().includes(item.exact), `source quote is absent: ${item.id}`);
      requireFact(typeof item.author === 'string' && item.author.trim(), `source author is missing: ${item.id}`);
      if (item.kind === 'text') requireFact(/^https?:\/\//u.test(item.url)
        && (item.rightsBasis === 'public-domain' || item.rightsBasis === 'licensed' && item.license), `text rights are unqualified: ${item.id}`);
    } else {
      const source = evidenceById.get(item.sourceEvidence);
      requireFact(source?.kind === 'record' && item.credit.trim() && item.rightsBasis.trim()
        && item.rightsBasis !== 'original-contribution' && Array.isArray(item.obligations) && item.obligations.length > 0,
        `licensed source media evidence is incomplete: ${item.id}`);
      const record = JSON.parse(pinnedBytes(checkout, source, false).toString());
      requireFact(auditPointer(record, source.pointer) === item.url, `media URL does not match its exact source field: ${item.id}`);
      // Raster signatures/dimensions are checked by the existing release/media
      // consumer and mapper; a digest alone is never a publication permission.
    }
  }
  const current = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: checkout, encoding: 'utf8' }).trim();
  const blockers = auditProductBlockers(recipe.productRevision, current), selections = new Map<string, DatasetSelectionResult>();
  for (const input of recipe.imports) {
    const snapshot = snapshots.get(input.snapshot);
    requireFact(snapshot, `import does not name an independently frozen snapshot: ${input.snapshot}`);
    const selection = selectDatasetRoots(snapshot, input.selection);
    selections.set(input.snapshot, selection);
    blockers.push(...auditSelectionBlockers(input, selection));
    for (const mapper of input.mappers) if (!mappers.some(available => available.id === mapper.id && available.revision === mapper.revision))
      blockers.push({ owner: 'dataset-native-mappers', stage: input.snapshot, detail: `missing registered mapper ${mapper.id}@${mapper.revision}` });
  }
  for (const role of ['cover', 'portrait']) if (!recipe.evidence.some(item => item.kind === 'media' && item.role === role))
    blockers.push({ owner: 'licensed-media-source', stage: 'qualification', detail: `no retained qualified real ${role} evidence` });
  if (!recipe.evidence.some(item => item.kind === 'text')) blockers.push({ owner: 'public-domain-source', stage: 'qualification',
    detail: 'no retained qualified Book/Recipe text; API answers and original author test prose cannot establish source facts' });
  return { recipe, recipePin: { file, sha256: sha256(bytes) }, originals, snapshots, selections, sourcePins, blockers,
    inspectionMs: Date.now() - inspectionStarted };
}

/** Native IDs in literal projections must have entered via an original binding
 * or a genuine successful response. No new UUID/name replacement can be staged. */
export function assertAuditNativeProvenance(value: RetainedJson, observed: ReadonlySet<string>): void {
  if (typeof value === 'string' && native.test(value)) requireFact(observed.has(value), `native identity has no observed owner binding: ${value}`);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) assertAuditNativeProvenance(item, observed);
}
export function auditSelectionIsWholeSnapshot(snapshot: DatasetSnapshot, selection: DatasetSelectionResult): boolean {
  return selection.status === 'complete' && hash(selection.selection.sources) === hash(snapshot.sources)
    && hash(selection.selection.images) === hash(snapshot.images) && hash(selection.selection.captures) === hash(snapshot.captures);
}
function collectNative(value: RetainedJson, output: Set<string>): void {
  // Generation tokens also come from actual owner results, not invented counters.
  if (typeof value === 'string') output.add(value);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) collectNative(item, output);
}

export function assertAuditGenerationProvenance(value: RetainedJson, observed: ReadonlySet<string>): void {
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (/^(?:modelGeneration|dataEpoch|sequence|oldGeneration|newGeneration)$/u.test(key))
      requireFact(typeof item === 'string' && observed.has(item), `generation ${key} has no observed owner receipt`);
    assertAuditGenerationProvenance(item, observed);
  }
}

export interface AuditSession {
  runId: string; apps: Record<string, string>; owners: Record<string, string>;
  preparation: { restoreMs: number; startupMs: number; readinessMs: number; totalMs: number };
  realms: Record<string, RetainedPersonaRealm>;
  request(realm: string, persona: PersonaName, method: string, path: string, body: RetainedJson, key: string | null): Promise<{ status: number; answer: RetainedJson }>;
  grant(input: AuditRecipe['grants'][number]): Promise<AuditGrantReceipt>;
  emptyIdentity(realm: string): Promise<RetainedJson>;
  import(input: AuditRecipe['imports'][number], snapshot: DatasetSnapshot, selection: DatasetSelectionResult): Promise<RetainedJson>;
  /** Close API writers before a physical cut; stop removes only this isolated copy. */
  quiesce(): Promise<void>; stop(): Promise<void>;
}
export interface AuditRuntime {
  revision: string;
  mappers: readonly DatasetNativeMapper[];
  open(inspection: AuditInspection, budget: FixtureWorkBudget, observe: (event: RetainedJson) => void): Promise<AuditSession>;
  cut(context: SourceContext, session: AuditSession): Promise<{ backup: string; rdfDigest: string; ownerState: RetainedOwnerState }>;
  restore(backup: string, metadata: Pick<AuditPreparationMetadata, 'realms'>, budget: FixtureWorkBudget, runId?: string): Promise<AuditSession>;
  verify(context: SourceContext, manifest: RetainedSourceManifest<RetainedJson>): Promise<string[]>;
  remove(key: string): Promise<void>;
}

function supportedPath(path: RetainedJson, method: string): asserts path is string {
  requireFact(typeof path === 'string' && /^\/v1\/[a-z][a-z0-9-]*(?:[/?]|$)/u.test(path)
    && !path.includes('://') && !/[\r\n\\#]/u.test(path) && !path.split('/').includes('..'), 'only relative supported public API paths are admitted');
  requireFact(!/^\/v1\/(?:quer(?:y|ies)|search|sparql|admin|maintenance)(?:[/?]|$)/u.test(path),
    'preparation must not write owner stores or record a query-under-proof as its oracle');
  requireFact(method !== 'GET' || !/^\/v1\/(?:me|account)(?:[/?]|$)/u.test(path), 'read-ready data is not an identity mutation');
}

export class AuditRecorder {
  readonly bindings = new Map<string, RetainedJson>();
  readonly observed = new Set<string>();
  readonly receiptPins: AuditFilePin[] = [];
  constructor(readonly file: string, private readonly now = Date.now) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, '', { mode: 0o600, flag: 'wx' });
  }
  event(value: RetainedJson): void { appendFileSync(this.file, JSON.stringify(value) + '\n'); }
  bind(name: string, value: RetainedJson): void {
    requireFact(!this.bindings.has(name), `duplicate result binding ${name}`);
    this.bindings.set(name, value); collectNative(value, this.observed);
  }
  async read(session: AuditSession, input: Pick<AuditReadPredicate, 'id' | 'realm' | 'persona'> & { path: string },
    phase: string): Promise<{ status: number; answer: RetainedJson }> {
    supportedPath(input.path, 'GET');
    const identity = input.persona === 'visitor' ? undefined : session.realms[input.realm]?.identities[input.persona];
    requireFact(input.persona === 'visitor' || identity, 'read has no retained persona identity');
    const receipt: AuditCommandReceipt = { id: input.id, phase, method: 'GET', path: input.path, key: null,
      caller: { realm: input.realm, persona: input.persona, accountId: identity?.accountId ?? null,
        actingSubject: identity?.actingSubject ?? null }, body: null,
      startedAt: this.now(), finishedAt: this.now(), status: null, answer: null };
    try {
      const answer = await session.request(input.realm, input.persona, 'GET', input.path, null, null);
      Object.assign(receipt, answer, { finishedAt: this.now() });
      this.event(json({ event: 'read-finished', ...receipt }));
      return answer;
    } catch (error) {
      receipt.finishedAt = this.now(); receipt.error = 'transport failed; no HTTP answer observed';
      this.event(json({ event: 'read-failed', ...receipt }));
      throw error;
    }
  }
  async command(session: AuditSession, input: AuditCommand, phase: string): Promise<void> {
    const path = resolveAuditValue(input.path, this.bindings), body = resolveAuditValue(input.body, this.bindings);
    supportedPath(path, input.method);
    const identity = session.realms[input.realm]?.identities[input.persona];
    requireFact(identity, 'command has no retained persona identity');
    const receipt: AuditCommandReceipt = { id: input.id, phase, method: input.method, path, key: input.key,
      caller: { realm: input.realm, persona: input.persona, accountId: identity.accountId, actingSubject: identity.actingSubject },
      body, startedAt: this.now(), finishedAt: this.now(), status: null, answer: null };
    this.event(json({ event: 'command-started', ...receipt }));
    try {
      const answer = await session.request(input.realm, input.persona, input.method, path, body, input.key);
      Object.assign(receipt, answer, { finishedAt: this.now() });
      this.event(json({ event: 'command-finished', ...receipt }));
      if (answer.status !== input.status) throw new AuditCorpusBlocked('public-api', phase,
        `${input.id}: ${input.method} ${path} expected ${input.status}, observed ${answer.status}; no replay attempted`);
      // Search's existing parser consumes one JSON command per evidence file,
      // rather than the multi-command JSONL ledger. Retain the same actual answer
      // outside disposable publication trees, and bind it only after success.
      const bytes = JSON.stringify(receipt) + '\n';
      const pin = { file: `${this.file}.${sha256(input.id)}.json`, sha256: sha256(bytes) };
      writeFileSync(pin.file, bytes, { mode: 0o600, flag: 'wx' });
      this.receiptPins.push(pin);
      const evidence = { path: pin.file, sha256: pin.sha256 };
      this.event(json({ event: 'command-evidence-retained', id: input.id, phase, ...evidence }));
      this.bind(`receipt:${input.id}`, evidence);
      this.bind(`command:${input.id}`, json(receipt));
    } catch (error) {
      if (receipt.status === null) {
        receipt.finishedAt = this.now(); receipt.error = 'transport failed; no HTTP answer observed';
        this.event(json({ event: 'command-failed', ...receipt }));
      }
      throw error;
    }
  }
}

async function verifyOriginals(session: AuditSession, inspection: AuditInspection, recorder: AuditRecorder,
  budget: FixtureWorkBudget, phase: string): Promise<void> {
  const realm = inspection.recipe.realms.find(item => item.visibility === 'public')!.id;
  for (const binding of inspection.originals.bindings) {
    budget.remaining();
    const response = await recorder.read(session, { id: binding.sourceKey, realm, persona: 'operator', path: binding.readPath }, phase);
    if (response.status !== 200 || auditPointer(response.answer, binding.resourcePointer) !== binding.resource
      || auditPointer(response.answer, binding.mainVersionPointer) !== binding.mainVersion
      || auditPointer(response.answer, binding.revisionPointer) !== binding.revision)
      throw new AuditCorpusBlocked('original-native-bindings', 'originals', `original identity/revision differs: ${binding.sourceKey}; never replace it by title`);
  }
}
async function readiness(session: AuditSession, predicates: AuditReadPredicate[], recorder: AuditRecorder,
  budget: FixtureWorkBudget, phase: string): Promise<void> {
  for (const predicate of predicates) {
    budget.remaining();
    const path = resolveAuditValue(predicate.path, recorder.bindings);
    supportedPath(path, 'GET');
    const answer = await recorder.read(session, { ...predicate, path }, phase);
    requireFact(answer.status === predicate.status, `read-ready predicate ${predicate.id}: expected ${predicate.status}, observed ${answer.status}`);
    for (const [pointer, value] of Object.entries(predicate.equals)) requireFact(hash(auditPointer(answer.answer, pointer)) === hash(resolveAuditValue(value, recorder.bindings)),
      `read-ready identity differs: ${predicate.id}${pointer}`);
    recorder.event(json({ event: 'read-ready', id: predicate.id, phase, status: answer.status, path,
      realm: predicate.realm, persona: predicate.persona, matches: Object.keys(predicate.equals) }));
    // The current read binding is replaced only after successful identity checks
    // on each copy. Historical phase bindings and response bytes remain retained.
    recorder.bind(`read:${phase}:${predicate.id}`, json(answer));
    recorder.bindings.set(`read:${predicate.id}`, json(answer));
    if (answer.status === 404) for (const id of path.matchAll(/(?<![a-f0-9-])[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}(?![a-f0-9-])/gu))
      recorder.observed.add(`https://rezics.com/id/${id[0]}`);
  }
}

export function auditSpecification(checkout: string, inspection: AuditInspection): SourceInputs {
  return { producer: 'audit-corpus', version: '1',
    files: sourceFileDigests(checkout, ['scripts/qa/fixtures/audit-corpus.ts', 'tests/qa/fixtures/audit-corpus-contract.ts',
      'scripts/fixture/budget.ts', 'scripts/qa/retained-source.ts',
      'tests/qa/support/personas.ts', 'tests/qa/support/author-management-fixture.ts', 'tests/qa/support/identity-reader-fixture.ts',
      'tests/qa/fixtures/catalogue-information-contract.ts', 'tests/qa/fixtures/catalogue-information-matrix.ts',
      'tests/qa/fixtures/catalogue-public-domain.ts', 'tests/qa/support/context-outcomes.ts',
      'tests/qa/support/import-outcomes.ts', 'tests/qa/integration/support/catalogue-release-media.ts',
      'tests/qa/fixtures/catalogue/import-outcomes.json', 'scripts/datasets/import.ts', 'scripts/datasets/selection.ts',
      'scripts/datasets/native/fields.ts', 'scripts/datasets/native/media.ts', 'scripts/datasets/native/context.ts',
      'scripts/datasets/native/coverage.ts', 'scripts/load/catalogue-backup.ts', 'scripts/load/corpus-backup-driver.ts']),
    inputs: json({ corpusOrigin: 'public-api-command-created', recipe: inspection.recipePin.sha256,
      originals: inspection.recipe.originals.sha256, sourcePins: inspection.sourcePins }) as RetainedOwnerState,
    compatibility: json(loadCompatibility(checkout)) as RetainedOwnerState };
}

export function auditCorpusAdapter(checkout: string, inspection: AuditInspection, runtime: AuditRuntime,
  directory = join(checkout, '.temp/audit-corpus/sources'), now = Date.now,
  earlierWorkMs = inspection.inspectionMs): RetainedSourceAdapter<RetainedJson, AuditSession> {
  const adapterStarted = now();
  const specification = auditSpecification(checkout, inspection), key = sourceKey(specification), finalBackup = join(directory, key, 'backup/owners/backup.json');
  const preparationOverheadMs = earlierWorkMs + now() - adapterStarted, charged = new WeakSet<FixtureWorkBudget>();
  const chargeInspection = (context: SourceContext) => {
    if (!charged.has(context.budget)) { context.budget.includeElapsedWork(preparationOverheadMs); charged.add(context.budget); }
    context.budget.remaining();
  };
  return {
    specification,
    async build(context) {
      if (inspection.blockers.length) {
        const blocker = inspection.blockers[0]!;
        throw new AuditCorpusBlocked(blocker.owner, blocker.stage, blocker.detail);
      }
      const recorder = new AuditRecorder(join(checkout, '.temp/audit-corpus/attempts', `${key}-${randomUUID()}.jsonl`), now);
      let session: AuditSession | undefined, smoke: AuditSession | undefined;
      recorder.bind('originals', json(inspection.originals));
      const importRecords = auditImportRecordInputs(inspection.snapshots);
      recorder.bind('source', json({ root: resolve(checkout, inspection.recipe.sourceRoot), pins: inspection.sourcePins,
        records: Object.fromEntries(importRecords) }));
      // Absence is not a created identity. These IDs enter provenance only after
      // an actual public 404 readiness read, below.
      recorder.bindings.set('controls', Object.fromEntries((inspection.recipe.unknownControls ?? [])
        .map(name => [name, `https://rezics.com/id/${randomUUID()}`])));
      try {
        chargeInspection(context);
        context.budget.includeElapsedWork(inspection.recipe.inputPreparationMs ?? 0);
        context.budget.remaining();
        session = await runtime.open(inspection, context.budget, event => recorder.event(event));
        recorder.bind('realms', json(session.realms));
        recorder.bind('identities', { empty: await session.emptyIdentity(inspection.recipe.emptyIdentityRealm) });
        await verifyOriginals(session, inspection, recorder, context.budget, 'original-before');
        const grants: AuditGrantReceipt[] = [];
        for (const grant of inspection.recipe.grants) {
          context.budget.remaining();
          const result = await session.grant(grant);
          grants.push(result); recorder.event(json({ event: 'fixture-authority', ...result }));
        }
        recorder.bind('authority', json(grants));
        for (const input of inspection.recipe.imports) {
          context.budget.remaining();
          const answer = await session.import(input, inspection.snapshots.get(input.snapshot)!, inspection.selections.get(input.snapshot)!);
          recorder.bind(`import:${input.snapshot}`, answer);
          recorder.event(json({ event: 'dataset-import-completed', snapshot: input.snapshot, result: answer }));
        }
        for (const stage of inspection.recipe.stages) {
          recorder.event({ event: 'stage-started', stage: stage.id });
          for (const command of stage.commands) { context.budget.remaining(); await recorder.command(session, command, stage.id); }
          recorder.event({ event: 'stage-completed', stage: stage.id });
        }
        await verifyOriginals(session, inspection, recorder, context.budget, 'original-after');
        await readiness(session, inspection.recipe.readiness, recorder, context.budget, 'prepared');
        await session.quiesce();
        const cut = await runtime.cut(context, session);
        const receiptsPath = join(context.backup, 'commands.jsonl');
        writeFileSync(receiptsPath, readFileSync(recorder.file), { mode: 0o600 });
        const metadata: AuditPreparationMetadata = { format: 'audit-corpus-preparation-v1', recipe: inspection.recipePin,
          sourceRunId: session.runId, originals: inspection.originals.bindings, realms: session.realms, grants,
          manifests: inspection.recipe.manifests,
          receipts: { file: join(directory, key, 'backup/commands.jsonl'), sha256: sha256(readFileSync(receiptsPath)) },
          sourcePins: [...inspection.sourcePins, ...recorder.receiptPins], sourceOwners: session.owners,
          buildMs: context.budget.elapsed(), roundTripMs: 0 };
        // A successful physical copy alone is not read-ready. Round-trip the same
        // cut and use independent source expectations, never query result snapshots.
        const restoreStarted = now();
        smoke = await runtime.restore(cut.backup, metadata, context.budget);
        await verifyOriginals(smoke, inspection, recorder, context.budget, 'original-round-trip');
        await readiness(smoke, inspection.recipe.readiness, recorder, context.budget, 'round-trip');
        recorder.bind('preparation', json({ sourceKey: key, backup: finalBackup, backupSha256: sha256(readFileSync(cut.backup)),
          sourceRunId: session.runId, productRevision: runtime.revision, baselineProduct: auditBaseline,
          buildMs: metadata.buildMs, roundTripMs: now() - restoreStarted, sourceOwners: session.owners }));
        recorder.bind('restore', json({ runId: smoke.runId, owners: smoke.owners, preparation: smoke.preparation }));
        const cutManifest = { key, metadata: json(metadata), readBackup: cut.backup, provenance: { producerRevision: runtime.revision,
          elapsedMs: context.budget.elapsed(), backupPath: join(directory, key, 'backup') } };
        for (const consumer of Object.keys(auditConsumers) as AuditConsumer[]) {
          const fragment = resolveAuditValue(inspection.recipe.manifests[consumer], recorder.bindings);
          const manifest = projectAuditManifest(consumer, fragment, cutManifest, smoke, checkout, runtime.revision);
          assertAuditNativeProvenance(manifest, recorder.observed);
          assertAuditGenerationProvenance(manifest, recorder.observed);
          assertAuditManifest(consumer, manifest, inspection.originals.bindings.map(binding => binding.resource),
            { records: importRecords, bindings: recorder.bindings });
        }
        await smoke.stop(); smoke = undefined;
        metadata.roundTripMs = now() - restoreStarted;
        await session.stop(); session = undefined;
        metadata.buildMs = context.budget.elapsed();
        context.budget.remaining();
        // Save actual bindings for later projections; runtime addresses/generations
        // are rebound only when an isolated compatible copy is actually restored.
        writeFileSync(join(context.backup, 'bindings.json'), JSON.stringify(Object.fromEntries(recorder.bindings)) + '\n', { mode: 0o600 });
        writeFileSync(join(context.backup, 'observed.json'), JSON.stringify([...recorder.observed]) + '\n', { mode: 0o600 });
        writeFileSync(receiptsPath, readFileSync(recorder.file), { mode: 0o600 });
        metadata.receipts.sha256 = sha256(readFileSync(receiptsPath));
        return { metadata: json(metadata), rdfDigest: cut.rdfDigest, ownerState: cut.ownerState,
          producerRevision: runtime.revision, qaIdentity: metadata.sourceRunId,
          phases: { 'build-through-round-trip': metadata.buildMs, 'round-trip': metadata.roundTripMs } };
      } catch (error) {
        recorder.event(json({ event: 'preparation-failed', assertionsReached: false, elapsedMs: context.budget.elapsed(),
          owner: error instanceof AuditCorpusBlocked ? error.owner : 'preparation',
          stage: error instanceof AuditCorpusBlocked ? error.stage : 'owner-stage',
          message: error instanceof AuditCorpusBlocked ? error.message : 'owner stage failed; no ready source or consumer manifest published' }));
        throw error;
      } finally { try { await smoke?.stop(); } finally { await session?.stop(); } }
    },
    async verify(context, manifest) {
      chargeInspection(context);
      const metadata = manifest.metadata as unknown as AuditPreparationMetadata;
      const reasons: string[] = [];
      if (metadata.format !== 'audit-corpus-preparation-v1' || metadata.recipe.sha256 !== inspection.recipePin.sha256)
        reasons.push('audit recipe/source metadata differs');
      if (metadata.buildMs <= 0 || metadata.buildMs > auditPreparationBudgetMs || metadata.roundTripMs <= 0)
        reasons.push('complete preparation/round-trip cost is missing or exceeds 600 seconds');
      for (const pin of metadata.sourcePins) { try { pinnedBytes(checkout, pin, false); } catch { reasons.push(`pinned evidence changed: ${pin.file}`); } }
      if (sha256(readFileSync(join(context.backup, 'commands.jsonl'))) !== metadata.receipts.sha256) reasons.push('command receipt ledger differs');
      return [...reasons, ...await runtime.verify(context, manifest)];
    },
    async restore(context, manifest) {
      chargeInspection(context);
      return runtime.restore(join(context.backup, 'owners/backup.json'), manifest.metadata as unknown as AuditPreparationMetadata, context.budget);
    },
    async dispose(candidate) { await candidate.stop(); },
    remove: key => runtime.remove(key),
  };
}

type FrozenImportInput = Pick<RetainedRecordInput, 'identity' | 'snapshot' | 'record' | 'recordDigest'>;
export interface AuditImportInputs {
  records: ReadonlyMap<string, FrozenImportInput>;
  bindings: ReadonlyMap<string, RetainedJson>;
}

/** Expose the already inspected complete records to the existing ref operator.
 * Provider payloads and normalized records keep their separate coordinates. */
export function auditImportRecordInputs(snapshots: ReadonlyMap<string, DatasetSnapshot>): Map<string, FrozenImportInput> {
  const inputs = new Map<string, FrozenImportInput>();
  for (const pin of matrix.sources) {
    const snapshot = snapshots.get(pin.id);
    if (!snapshot) continue;
    requireFact(snapshot.id === pin.id && snapshot.digest === pin.digest, 'import snapshot pin differs');
    const source = snapshot.sources.find(candidate => candidate.provider === pin.provider);
    const recordDigests: Record<string, string | undefined> = pin.recordDigests;
    for (const key of pin.recordKeys) {
      const record = source?.records.find(candidate => candidate.key === key);
      requireFact(record && hash(record) === recordDigests[key], `frozen import record differs: ${key}`);
      inputs.set(key, { identity: { key, provider: record.provider, namespace: record.kind, externalId: record.externalId },
        snapshot: { id: pin.id, digest: pin.digest, fileSha256: pin.fileSha256 }, record, recordDigest: hash(record) });
    }
  }
  return inputs;
}

/** Validate consumer inputs, not the proposed conversion's success. Receipt
 * joins use the existing recorder; an unrelated observed UUID is insufficient. */
function assertAuditImportSources(value: Record<string, unknown>, inputs: AuditImportInputs): void {
  requireFact(object(value.sources), 'import source receipts are missing');
  const receipts: Array<Pick<AuditCommandReceipt, 'method' | 'path' | 'key' | 'body' | 'status' | 'answer'> & { coordinate?: DatasetIntakeCoordinate }> = [...inputs.bindings].filter(([key, receipt]) => key.startsWith('command:') && object(receipt)
    && [200, 201].includes(Number(receipt.status)) && !receipt.error)
    .map(([, receipt]) => receipt as unknown as AuditCommandReceipt);
  // The importer owns these requests and replies. Keep their actual custody;
  // do not manufacture command timestamps, callers or an absent HTTP status.
  for (const [name, imported] of inputs.bindings) {
    if (!name.startsWith('import:') || !object(imported) || !object(imported.intakeCustody)) continue;
    const custody = imported.intakeCustody;
    requireFact(custody.format === 'rezics-dataset-intake-receipts-v1' && Array.isArray(custody.commands), 'invalid importer intake custody');
    for (const value of custody.commands) {
      if (!object(value) || !object(value.result) || !Array.isArray(value.responses)) continue;
      const command = value as unknown as DatasetIntakeCommand;
      if (command.coordinate?.purpose !== 'record') continue;
      const frozen = inputs.records.get(command.coordinate.identity.key);
      if (!frozen) continue;
      requireFact(hash(custody.snapshot) === hash(frozen.snapshot)
        && hash(command.coordinate.snapshot) === hash(frozen.snapshot)
        && hash(command.coordinate.identity) === hash(frozen.identity)
        && command.coordinate.recordDigest === frozen.recordDigest, 'importer intake coordinate differs from the frozen record');
      const reply = command.responses.find(response => [200, 201].includes(response.status ?? 0)
        && hash(response.body) === hash(command.result));
      if (!reply) continue;
      const part = datasetIntakeReceipt(command, command.request);
      receipts.push({ method: command.method, path: command.path, key: command.key, body: json(command.request),
        status: reply.status!, answer: json(part.command.result), coordinate: command.coordinate });
    }
  }
  const equal = (actual: unknown, expected: unknown) => actual !== undefined && hash(actual) === hash(expected);
  const result = (receipt: typeof receipts[number], key: string) => object(receipt.answer) ? receipt.answer[key] : undefined;
  for (const key of retainedAdmissionCases) requireFact(object(value.sources[key]), `missing retained admission source: ${key}`);
  for (const [key, entry] of Object.entries(value.sources)) {
    const frozen = inputs.records.get(key);
    if (!frozen) throw new AuditCorpusBlocked('retained-source', 'import-retained-inputs', `missing exact frozen record: ${key}`);
    requireFact(object(entry) && native.test(String(entry.record)) && native.test(String(entry.observation))
      && Array.isArray(entry.parts) && entry.parts.length > 0, `invalid import intake inputs: ${key}`);
    const sourceParts = entry.parts;
    const parts = sourceParts.map((part: unknown, index: number) => {
      requireFact(object(part) && native.test(String(part.record)) && native.test(String(part.observation))
        && typeof part.rawBytesBase64 === 'string' && hex.test(String(part.rawDigest)), `invalid actual intake part: ${key}`);
      const bytes = Buffer.from(part.rawBytesBase64, 'base64');
      requireFact(bytes.toString('base64') === part.rawBytesBase64 && bytes.length <= 65_536
        && sha256(bytes) === part.rawDigest, `intake raw bytes differ: ${key}`);
      const intake = receipts.find(receipt => {
        const observation = result(receipt, 'observation'), body = receipt.body;
        return receipt.method === 'POST' && receipt.path === '/v1/sources/intakes' && typeof receipt.key === 'string'
          && (!receipt.coordinate || receipt.coordinate.index === index && receipt.coordinate.count === sourceParts.length)
          && object(body) && body.profile === 'source-manual-intake-v1' && body.provider === frozen.identity.provider
          && body.sourceRevision === frozen.snapshot.digest && body.retention === 'retained' && object(body.rightsEvidence)
          && body.rawBytesBase64 === part.rawBytesBase64 && object(observation)
          && observation.record === part.record && observation.observation === part.observation
          && observation.byteDigest === part.rawDigest && observation.byteLength === bytes.length
          && observation.provider === body.provider && observation.sourceRevision === body.sourceRevision
          && observation.namespace === body.namespace && observation.externalId === body.externalId;
      });
      if (!intake) throw new AuditCorpusBlocked('dataset-importer', 'import-intake-receipts',
        `${key}: retain the successful POST /v1/sources/intakes request and matching part record/observation/byte receipt in command:<id> or import:<snapshot>.intakeCustody`);
      return { part, bytes };
    });
    requireFact(parts.some(({ part }) => part.record === entry.record && part.observation === entry.observation),
      `legacy Source identity is not an actual intake pair: ${key}`);
    const payload = reconstructIntake(parts.map(part => part.bytes));
    const envelope = object(payload) && payload.format === 'rezics-dataset-record-v1';
    const expectedPayload = envelope ? frozen.record
      : key.startsWith('bangumi:') && frozen.record.data.api_subject ? frozen.record.data.api_subject : frozen.record.data;
    requireFact(equal(envelope ? payload.record : payload, expectedPayload),
      `intake payload does not match the frozen record/provider bytes: ${key}`);
    const conversion = entry.conversion;
    if (conversion !== undefined) requireFact(native.test(String(conversion)) && receipts.some(receipt => {
      const answer = result(receipt, 'conversion');
      return receipt.method === 'POST' && receipt.path === `/v1/sources/observations/${String(entry.observation).slice(-36)}/conversions`
        && object(answer) && answer.conversion === conversion && answer.observation === entry.observation;
    }), `conversion has no matching actual command result: ${key}`);
    if (entry.proposal !== undefined) requireFact(conversion !== undefined && native.test(String(entry.proposal)) && receipts.some(receipt => {
      const answer = result(receipt, 'proposal');
      return receipt.method === 'POST' && receipt.path === `/v1/sources/conversions/${String(conversion).slice(-36)}/proposals/native-work`
        && object(answer) && answer.proposal === entry.proposal && answer.conversion === conversion
        && answer.record === entry.record && answer.observation === entry.observation;
    }), `proposal has no matching actual command result: ${key}`);
    // These existing editorial and authority cases still address real legacy
    // Bangumi commands. Other records need no successful proposed conversion.
    if (key === 'bangumi:subject:1014') requireFact(conversion !== undefined && entry.proposal !== undefined,
      'Bangumi editorial and negative-authority prerequisites need the actual conversion and proposal');
    const request = entry.retainedRequest;
    if ((retainedAdmissionCases as readonly string[]).includes(key) || request !== undefined) {
      requireFact(object(request) && request.profile === 'source-retained-record-conversion-v1'
        && typeof request.mappingRevision === 'string' && request.mappingRevision.length > 0 && object(request.retained),
      `missing exact retainedRequest: ${key}`);
      const retained = request.retained;
      requireFact(equal(Object.keys(request).sort(), ['mappingRevision', 'profile', 'retained'])
        && equal(Object.keys(retained).sort(), ['identity', 'intakes', 'payload', 'record', 'recordDigest', 'snapshot']),
      `retainedRequest has fields outside the proposed input contract: ${key}`);
      for (const field of ['identity', 'snapshot', 'record', 'recordDigest'] as const)
        requireFact(equal(retained[field], frozen[field]), `retainedRequest ${field} differs from the full frozen record: ${key}`);
      requireFact(equal(retained.intakes, parts.map(({ part }, index) => ({ index, record: part.record,
        observation: part.observation, byteDigest: part.rawDigest }))), `retainedRequest ordered actual intakes differ: ${key}`);
      const first = JSON.parse(parts[0]!.bytes.toString()) as Record<string, unknown>;
      requireFact(equal(retained.payload, first.format === 'rezics-dataset-chunk-v1'
        ? { format: 'rezics-dataset-chunk-v1', byteDigest: first.digest, byteLength: first.byteLength }
        : { format: 'json', byteDigest: sha256(parts[0]!.bytes), byteLength: parts[0]!.bytes.length }),
      `retainedRequest assembled payload metadata differs: ${key}`);
      if (entry.retainedBinding !== undefined) {
        const binding = entry.retainedBinding;
        requireFact(object(binding) && binding.profile === 'source-retained-record-binding-v1'
          && ['binding', 'sourceRecord', 'conversion'].every(field => native.test(String(binding[field])))
          && typeof binding.normalizationRevision === 'string' && binding.normalizationRevision.length > 0
          && binding.mappingRevision === request.mappingRevision, `invalid observed retainedBinding: ${key}`);
        for (const field of ['identity', 'snapshot', 'recordDigest', 'intakes', 'payload'])
          requireFact(equal(binding[field], retained[field]), `retainedBinding input differs: ${key}`);
        requireFact(receipts.some(receipt => {
          const answer = result(receipt, 'conversion');
          return receipt.method === 'POST' && receipt.path === `/v1/sources/observations/${String(parts[0]!.part.observation).slice(-36)}/conversions`
            && equal(receipt.body, request) && object(answer) && answer.conversion === binding.conversion
            && equal(answer.retainedRecord, binding);
        }), `retainedBinding has no matching actual conversion result: ${key}`);
      }
    } else requireFact(entry.retainedBinding === undefined, `retainedBinding lacks its exact request: ${key}`);
  }
  if (value.synopsisSupport !== undefined) {
    const support = value.synopsisSupport, source = value.sources['bangumi:subject:1014'] as Record<string, unknown>;
    const target = object(value.targets) && value.targets['bangumi:subject:1014'];
    requireFact(object(support) && native.test(String(support.support)) && typeof support.supportIdentity === 'string'
      && support.supportIdentity.length > 0 && object(target), 'invalid observed synopsisSupport');
    requireFact(receipts.some(receipt => receipt.method === 'POST'
      && receipt.path === `/v1/works/${String(target.resource).slice(-36)}/fields/synopsis/control`
      && object(receipt.body) && receipt.body.profile === 'work-editorial-field-control-v1' && receipt.body.origin === 'source'
      && object(receipt.body.source) && receipt.body.source.record === source.record
      && receipt.body.source.observation === source.observation && receipt.body.source.conversion === source.conversion
      && result(receipt, 'support') === support.support), 'synopsisSupport has no actual source-origin control result');
    requireFact(receipts.some(receipt => receipt.method === 'GET'
      && receipt.path === `/v1/sources/field-supports/${String(support.support).slice(-36)}` && object(receipt.answer)
      && receipt.answer.support === support.support && receipt.answer.supportIdentity === support.supportIdentity
      && receipt.answer.target === target.resource && receipt.answer.sourceRecord === source.record
      && receipt.answer.conversion === source.conversion), 'synopsisSupport lacks its matching private management receipt');
  }
}

/** Structural checks complement (and do not replace) the independent consumers'
 * deep assertions. No producer status promotes a pending product outcome. */
export function assertAuditManifest<C extends AuditConsumer>(consumer: C, value: unknown, originalWorks: readonly string[],
  importInputs?: AuditImportInputs): asserts value is AuditManifests[C] {
  requireFact(object(value), `${consumer} projection is not an object`);
  const signatures: Record<AuditConsumer, readonly [string, string, readonly string[]]> = {
    imports: ['profile', 'import-outcomes-corpus-v1', ['phase', 'productRevision', 'selectionDigest', 'runId', 'fixtureRoot', 'sourceRoot', 'targets', 'relations', 'sources', 'selections', 'hidden', 'music', 'refresh', 'authority', 'realm', 'backup', 'preparation']],
    context: ['format', 'restored-context-outcomes-v1', ['runId', 'corpus', 'preparation']],
    releases: ['format', 'catalogue-release-media-v1', ['selection', 'preparation', 'personas', 'catalogues', 'images', 'mediaDispositions', 'hidden', 'reading']],
    information: ['profile', 'catalogue-information-corpus-v1', ['productBaseline', 'preparation', 'realm', 'records', 'inverse', 'orders', 'collections', 'controls']],
    publicDomain: ['profile', 'catalogue-public-domain-corpus-v1', ['productRevision', 'backup', 'preparationMs', 'preparationQaRun', 'personas', 'importedWorks', 'richRecipe', 'noNutritionRecipe', 'nutritionRecipes', 'book']],
    identity: ['format', 'identity-reader-corpus-v1', ['recipe', 'productRevision', 'compatibility', 'backup', 'realm', 'emptyIdentity', 'alternatives', 'publicBook', 'emptyBook', 'privateBook', 'unpublishedBook', 'unpublishedRevision', 'phrase', 'buildMs']],
    author: ['format', 'author-management-corpus-v1', ['baselineProduct', 'buildHead', 'compatibility', 'recipeDigest', 'backup', 'preparedMs', 'realms', 'inventory', 'book', 'composition', 'chapterOccurrence', 'group', 'chapterGroup', 'chapterCount', 'chapter', 'chapterWorkRevision', 'post', 'postWorkRevision', 'adoption', 'reply', 'independentPlacement', 'independentReply']],
    search: ['format', 'rezics-retained-source-v1', ['key', 'specification', 'metadata', 'provenance']],
  };
  const [key, format, fields] = signatures[consumer];
  requireFact(value[key] === format && fields.every(field => Object.hasOwn(value, field)), `${consumer} projection does not match the existing consumer contract`);
  // Validate mandatory nested inventories before the manifest reaches a test
  // hook. The independent helpers retain their stronger semantic assertions.
  const required = (at: unknown, names: readonly string[], label: string) => {
    requireFact(object(at) && names.every(name => Object.hasOwn(at, name) && at[name] !== undefined), `${label} is missing required fields`);
    return at;
  };
  const list = (at: unknown, label: string, minimum = 0): unknown[] => {
    requireFact(Array.isArray(at) && at.length >= minimum, `${label} must be an array with at least ${minimum} items`);
    return at;
  };
  const realm = (at: unknown) => {
    assertRetainedRealm(at);
    const entry = required(at, ['realm', 'space', 'zone', 'visibility', 'identities', 'auth'], 'retained persona realm');
    const people = required(entry.identities, ['stranger', 'member', 'owner', 'moderator', 'operator'], 'retained personas');
    for (const person of Object.values(people)) required(person, ['email', 'password', 'accountId', 'actingSubject'], 'retained persona identity');
  };
  const book = (at: unknown) => {
    const entry = required(at, ['work', 'mainVersion', 'title', 'structure', 'compositionRevision', 'chapters'], 'identity Book');
    for (const chapter of list(entry.chapters, 'identity chapters'))
      required(chapter, ['post', 'variantId', 'occurrence', 'compositionRevision', 'revisionId', 'byteDigest', 'text'], 'identity chapter');
  };
  if (consumer === 'imports') {
    realm(value.realm);
    requireFact(typeof value.sourceRoot === 'string' && value.sourceRoot.length > 0, 'import frozen sourceRoot is missing');
    for (const target of Object.values(required(value.targets, [], 'import targets')))
      required(target, ['resource', 'revision', 'kind'], 'native import target');
    requireFact(importInputs, 'import validation requires frozen records and actual command bindings');
    assertAuditImportSources(value, importInputs);
    required(value.refresh, ['sourceKey', 'baseConversion', 'candidateConversion', 'command', 'oldGeneration', 'newGeneration'], 'source refresh');
    list(value.selections, 'import selections', 1);
  }
  if (consumer === 'context') {
    const corpus = required(value.corpus, ['format', 'corpusId', 'productBaseline', 'personas', 'catalogueWorks', 'cases', 'predicates',
      'protagonistRole', 'maleRole', 'privateRealm', 'unknownRealm', 'privateRoot', 'unknownRoot', 'overflow', 'credits', 'inverse', 'sparse', 'history', 'forbidden', 'receiptLedger'], 'context corpus');
    realm(corpus.personas);
    required(corpus.cases, ['redLead', 'mixedPeople', 'mixedOccurrences', 'otherRelease', 'otherCanon', 'otherTime', 'uncertain', 'conflicting', 'sourceProtagonist', 'explicitMale', 'realmOnly', 'privateCoParticipant', 'spoiler'], 'appearance cases');
    required(corpus.history, ['current', 'priorExact', 'withdrawnEvidence', 'independentEvidence', 'humanDecisionRevision', 'obsoleteSource', 'obsoleteModel', 'obsoleteRestore'], 'context generations');
  }
  if (consumer === 'releases') {
    realm(value.personas);
    for (const catalogue of list(value.catalogues, 'source catalogues', 2)) {
      const entry = required(catalogue, ['provider', 'work', 'mainVersion', 'releases', 'realizations', 'fields', 'selection', 'matchingReleases', 'counterexamples'], 'source catalogue');
      for (const release of list(entry.releases, 'native releases', 1))
        list(required(release, ['id', 'revision', 'status', 'platform', 'publicationYear', 'territory', 'identifiers', 'coverage', 'sourceEvidence'], 'native release').coverage, 'exact release coverage', 1);
    }
    for (const image of list(value.images, 'real source media', 2))
      required(image, ['resource', 'role', 'source', 'sourceRecord', 'sourcePointer', 'originalUrl', 'original', 'originalDimensions', 'mediaType', 'width', 'height', 'crop', 'credit', 'rights', 'delivery'], 'licensed media');
    required(value.reading, ['work', 'release', 'releaseRevision', 'language', 'realization', 'realizationRevision', 'structure', 'occurrence', 'chapter', 'contentRevision', 'position'], 'release-bound reading');
  }
  if (consumer === 'information') {
    realm(value.realm);
    required(value.records, ['character', 'person', 'organization', 'concept', 'publicationEvent', 'dataset', 'episode', 'artist', 'recording', 'composition', 'label', 'nativeRelease', 'book', 'recipe'], 'supporting records');
    required(value.orders, ['episodes', 'media', 'tracks'], 'ordered domain');
    required(value.collections, ['ordinary', 'bookList', 'recipes', 'series', 'franchise'], 'purpose collections');
    required(value.controls, ['states', 'values', 'empty', 'missing', 'nullRecipe', 'hidden', 'privateMutation', 'publicMutation', 'recovery'], 'information controls');
  }
  if (consumer === 'identity') {
    realm(value.realm); required(value.emptyIdentity, ['email', 'password', 'accountId'], 'Account-only identity');
    required(value.alternatives, ['stranger', 'member', 'owner', 'moderator', 'operator'], 'alternate identities');
    for (const key of ['publicBook', 'emptyBook', 'privateBook', 'unpublishedBook']) book(value[key]);
  }
  if (consumer === 'author') {
    for (const entry of list(value.realms, 'independent author realms', 2)) realm(entry);
    required(value.inventory, ['matching', 'draft', 'otherType', 'foreign', 'alternateAgent', 'alternate', 'edited'], 'author inventory');
    for (const key of ['chapter', 'post']) required(value[key], ['resourceId', 'variantId', 'revisionId', 'byteDigest', 'sourcePosition', 'publication', 'eligibility', 'body'], 'published author content');
    for (const key of ['reply', 'independentReply']) required(value[key], ['reply', 'variantId', 'revisionId', 'revisionDigest', 'author', 'rootTarget', 'rootRevision', 'body', 'placement'], 'author reply');
  }
  if (consumer === 'publicDomain') {
    realm(value.personas);
    list(value.nutritionRecipes, 'qualified nutrition recipes', 1);
    const corpus = value as unknown as AuditManifests['publicDomain'];
    requireFact(String(corpus.productRevision) === auditBaseline && corpus.importedWorks.length === 113
      && new Set(corpus.importedWorks).size === 113 && hash([...corpus.importedWorks].sort()) === hash([...originalWorks].sort()), 'public corpus must preserve the exact original 113 Works');
    for (const recipe of [corpus.richRecipe, corpus.noNutritionRecipe, ...corpus.nutritionRecipes])
      requireFact(required(recipe, ['work', 'workRevision', 'mainVersion', 'structure', 'revision', 'publisher', 'source', 'title', 'language', 'order', 'ingredients', 'steps', 'measures', 'nutrition', 'substitutions'], 'public Recipe')
        && originalWorks.includes(recipe.work) && recipe.source.author && recipe.source.observation
        && recipe.ingredients.length > 0 && recipe.steps.length > 0, 'real Recipe premise is missing');
    requireFact(originalWorks.includes(corpus.book.work) && corpus.book.chapters.length >= 2 && corpus.book.releases.length >= 2, 'real Book premise is missing');
    requireFact(corpus.noNutritionRecipe.nutrition === 'absent' && corpus.noNutritionRecipe.measures.every(item => item.value.kind !== 'nutrient'), 'unknown nutrition cannot become an empty qualified claim');
  }
  if (consumer === 'search') {
    const source = value as unknown as AuditManifests['search'];
    requireFact(/^rs-search-intent-[a-f0-9]{64}$/u.test(source.key) && source.specification.inputs.corpusOrigin === 'public-api-command-created'
      && source.metadata.format === 'search-intent-corpus-v1' && /^si[a-f0-9]{8}$/u.test(source.metadata.namespace), 'search retained source contract differs');
    for (const entry of list(source.metadata.realms, 'search realms', 2)) realm(entry);
    for (const record of Object.values(source.metadata.records)) {
      required(record, ['id', 'revision', 'readPath', 'namePointer', 'typesPointer', 'summaryPointer', 'revisionPointer', 'owner', 'evidence'], 'search record');
      list(record.evidence, 'search source evidence', 1);
    }
  }
}

interface AuditProjectionSource {
  key: string; metadata: RetainedJson;
  readBackup?: string;
  provenance: { producerRevision: string; elapsedMs: number; backupPath: string };
}

/** Read-only projection of the launch owner's retained small Book preparation.
 * It neither prepares another corpus nor publishes a ready fixture. Independent
 * execution, ledger and selected-consumer admission still run on the result. */
export function projectRetainedPublicDomainBook(checkout: string, preparationFile: string, originals: AuditFilePin): {
  manifest: RetainedJson; custody: RetainedJson;
} {
  const pins = new Map<string, AuditFilePin>();
  const read = (path: string, expected?: string): Record<string, unknown> => {
    const file = relative(checkout, auditLocalFile(checkout, path, false)), bytes = readFileSync(resolve(checkout, file));
    const digest = sha256(bytes);
    requireFact(expected === undefined || digest === expected, `file digest differs: ${file}`);
    pins.set(file, { file, sha256: digest });
    return jsonObject(JSON.parse(bytes.toString('utf8')));
  };
  const preparation = read(preparationFile), directory = dirname(auditLocalFile(checkout, preparationFile));
  const book = read(String(preparation.book)), execution = read(String(preparation.execution));
  const backup = read(String(preparation.backup)), personas = read(String(preparation.personas));
  assertRetainedRealm(personas);
  requireFact(backup.format === 'command-catalogue-backup-v1' && backup.runId === preparation.sourceRunId
    && execution.format === 'audit-execution-v1' && execution.productBaseline === auditBaseline
    && execution.fixtureGeneration === preparation.sourceRunId && typeof execution.productRevision === 'string'
    && /^[a-f0-9]{40}$/.test(execution.productRevision) && execution.testRevision === execution.productRevision
    && typeof preparation.preparationMs === 'number' && preparation.preparationMs > 0
    && preparation.preparationMs <= auditPreparationBudgetMs, 'retained Book preparation/execution/backup custody differs');
  // Keep the existing array bytes and their digest; a wrapper must not replace
  // this original association ledger merely to satisfy a later helper premise.
  const ledgerBytes = pinnedBytes(checkout, originals), ledger: unknown = JSON.parse(ledgerBytes.toString('utf8'));
  const bindings = Array.isArray(ledger) ? ledger : object(ledger) ? ledger.bindings : undefined;
  requireFact(Array.isArray(bindings) && bindings.length === 113 && bindings.every(binding => object(binding)
    && typeof binding.sourceKey === 'string' && native.test(String(binding.resource))
    && native.test(String(binding.mainVersion)) && native.test(String(binding.revision))), 'original 113 ledger is incomplete');
  for (const key of ['resource', 'mainVersion', 'sourceKey'])
    requireFact(new Set(bindings.map(binding => (binding as Record<string, unknown>)[key])).size === 113, `original ${key} differs`);
  pins.set(originals.file, originals);
  const receipts = readdirSync(join(directory, 'receipts')).filter(name => name.endsWith('.json')).map(name => {
    const file = relative(checkout, join(directory, 'receipts', name));
    return { file, value: read(file) };
  });
  const used = new Set<string>();
  const receipt = (path: string, matches: (body: Record<string, unknown>, answer: Record<string, unknown>) => boolean) => {
    const found = receipts.filter(({ value }) => value.method === 'POST' && value.path === path
      && typeof value.status === 'number' && value.status >= 200 && value.status < 300 && !('error' in value)
      && object(value.body) && object(value.answer) && matches(value.body, value.answer));
    requireFact(found.length === 1, `retained Book needs one actual successful receipt: ${path}`);
    used.add(found[0]!.file);
    return found[0]!.value;
  };
  const made = receipt('/v1/works', (_, answer) => answer.work === book.work);
  assertPublicDomainNativeCreation({ work: String(book.work), mainVersion: String(book.mainVersion) }, made);
  const author = jsonObject(book.author), description = jsonObject(book.description), mainText = jsonObject(book.mainText);
  const authorMade = receipt('/v1/agents', (_, answer) => answer.agent === author.agent);
  const authorName = auditPointer(authorMade, '/body/displayName');
  requireFact(typeof authorName === 'string' && authorName.length > 0, 'retained Book author name is missing');
  const draft = receipt('/v1/contributions', (_, answer) => answer.contribution === auditPointer(mainText, '/draft/contribution'));
  const publication = receipt('/v1/contribution-publications', (body, answer) =>
    body.contribution === auditPointer(draft, '/answer/contribution') && body.expectedDraftHead === auditPointer(draft, '/answer/draftRevision')
    && body.rightsBasis === 'original-contribution' && body.disclosure === 'public'
    && answer.publicationDecision === auditPointer(mainText, '/publication/publicationDecision'));
  receipt('/v1/publication-selections', (body, answer) => body.work === book.work
    && body.contribution === auditPointer(draft, '/answer/contribution')
    && body.publicationDecision === auditPointer(publication, '/answer/publicationDecision')
    && auditPointer(body, '/context/kind') === 'main-version-default' && auditPointer(body, '/context/id') === book.mainVersion
    && answer.selectedDraft === auditPointer(draft, '/answer/draftRevision'));
  const header = jsonObject(auditPointer(book, '/anonymous/header'));
  const contents = jsonObject(auditPointer(book, '/anonymous/contents'));
  requireFact(header.id === book.work && header.publicationState === 'published' && header.disclosure === 'public'
    && contents.work === book.work && contents.nextCursor === null && Array.isArray(contents.items), 'retained anonymous Book read is incomplete');
  const fixture = jsonObject(book.fixture), frozen = read(String(fixture.file), String(fixture.sha256));
  const canonical = classicText(checkout, gutenbergBooks[0]);
  requireFact(hash(book.chapters) === hash(canonical.chapters) && frozen.sourceSha256 === auditPointer(book, '/source/byteDigest')
    && typeof frozen.text === 'string', 'retained chapters differ from their existing frozen-text selection');
  const quote = (pin: AuditFilePin, exact: string) => ({ ...pin, exact });
  const descriptionRecord = read(String(description.file), String(description.sha256));
  const sourceDescription = typeof descriptionRecord.description === 'string' ? descriptionRecord.description
    : auditPointer(descriptionRecord, '/description/value');
  requireFact(typeof sourceDescription === 'string' && sourceDescription === description.sourceValue
    && sourceDescription.replace(/\s+/gu, ' ').trim() === description.value && sourceDescription.includes(authorName),
  'retained Book description/author source correspondence differs');
  const chapters = (contents.items as unknown[]).map((item, index) => {
    const chapter = jsonObject(item), body = canonical.chapters[index]?.body;
    requireFact(chapter.role === 'chapter' && chapter.availability === 'available' && typeof body === 'string', 'retained chapter is unavailable');
    const madeChapter = receipt(`/v1/works/${String(book.work).slice(-36)}/chapters`, (_, answer) =>
      answer.post === chapter.target && answer.occurrence === chapter.occurrence && answer.structure === contents.composition);
    const saved = receipt('/v1/content-drafts', (request, answer) => request.resourceId === chapter.target
      && request.variantId === auditPointer(madeChapter, '/answer/variantId') && request.body === body
      && `urn:rezics:content:revision:${String(answer.revisionId)}` === chapter.selectedRevision);
    const published = receipt('/v1/content-publications', (request, answer) => request.resourceId === chapter.target
      && request.variantId === auditPointer(saved, '/body/variantId') && request.revisionId === auditPointer(saved, '/answer/revisionId')
      && request.expectedDigest === auditPointer(saved, '/answer/byteDigest') && answer.status === 'active');
    receipt('/v1/content-search-eligibility', (request, answer) => request.resourceId === chapter.target
      && request.variantId === auditPointer(saved, '/body/variantId') && request.publicationDecision === auditPointer(published, '/answer/decision')
      && request.disclosure === 'public' && request.rightsBasis === 'public-domain' && answer.outcome === 'succeeded');
    // The oracle is an exact, meaningful source excerpt. Preserve printed line
    // wrapping in its quote and the native full body in the existing draft pin.
    const excerpt = body.slice(0, 400).replace(/\s+\S*$/u, '');
    const pattern = excerpt.split(/\s+/u).map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
    const exact = new RegExp(pattern, 'u').exec(frozen.text as string)?.[0];
    requireFact(excerpt.length >= 200 && exact, 'chapter source excerpt is not present in frozen bytes');
    return { occurrence: chapter.occurrence, parent: chapter.parent, target: chapter.target, selectedRevision: chapter.selectedRevision,
      body: quote({ file: String(fixture.file), sha256: String(fixture.sha256) }, exact), bodyText: excerpt };
  });
  requireFact(chapters.length === canonical.chapters.length, 'retained chapter count differs');
  const lock = JSON.parse(readFileSync(join(checkout, 'tests/fixtures/fixtures.lock.json'), 'utf8')) as {
    entries: Array<{ id: string; seed: string; sha256: string }>;
  };
  const editions = book.editions as Array<Record<string, unknown>>;
  const releaseAnswers = auditPointer(book, '/anonymous/releases/items') as Array<Record<string, unknown>>;
  requireFact(Array.isArray(editions) && Array.isArray(releaseAnswers) && editions.length === releaseAnswers.length
    && auditPointer(book, '/anonymous/releases/nextCursor') === null, 'retained release inventory is incomplete');
  const releases = editions.map(edition => {
    const answer = releaseAnswers.find(item => item.id === edition.release), entry = lock.entries.find(item => item.id === `edition-${String(edition.externalId)}`);
    requireFact(answer && answer.revision === edition.revision && entry, 'retained release identity/source is missing');
    const source = read(entry.seed, entry.sha256), coverage = (answer.coverage as Array<Record<string, unknown>>).filter(item => item.work === book.work);
    requireFact(source.key === `/books/${String(edition.externalId)}` && source.title === edition.title
      && coverage.length === 1 && coverage[0]!.realization === edition.realization && coverage[0]!.revision === edition.realizationRevision,
    'retained release coverage/source correspondence differs');
    return { id: answer.id, revision: answer.revision, platform: answer.platform,
      realization: coverage[0]!.realization, realizationRevision: coverage[0]!.revision, language: coverage[0]!.language,
      evidence: quote({ file: entry.seed, sha256: entry.sha256 }, String(source.title)) };
  });
  const creationFile = receipts.find(entry => entry.value === made)!.file;
  return { manifest: json({ profile: 'catalogue-public-domain-corpus-v1', productRevision: auditBaseline,
    execution, backup: relative(checkout, auditLocalFile(checkout, String(preparation.backup))),
    preparationMs: preparation.preparationMs, preparationQaRun: preparation.sourceRunId, personas,
    originals, importedWorks: bindings.map(binding => (binding as Record<string, unknown>).resource),
    book: { work: book.work, creationReceipt: { path: creationFile, sha256: pins.get(creationFile)!.sha256 },
      title: auditPointer(header, '/title/value'), language: header.selectedLanguage,
      description: { value: description.value, language: auditPointer(header, '/description/language'),
        evidence: quote({ file: String(description.file), sha256: String(description.sha256) }, sourceDescription) },
      author: { agent: author.agent, name: authorName,
        evidence: quote({ file: String(description.file), sha256: String(description.sha256) }, authorName) },
      composition: contents.composition, compositionRevision: contents.compositionRevision, chapters, releases } }),
  custody: json({ inputs: [...pins.values()], usedReceipts: [...used].map(file => pins.get(file)!),
    assertionsReached: false, selected: 'book', ready: false }) };
}

/** Product/proof identity, timing and backup custody are producer-owned fields.
 * Templates cannot override them or claim a restore that has not happened. */
export function projectAuditManifest(consumer: AuditConsumer, fragment: RetainedJson, source: AuditProjectionSource,
  copy: Pick<AuditSession, 'runId' | 'owners' | 'preparation'> | undefined, checkout: string, productRevision: string): RetainedJson {
  requireFact(object(fragment), `${consumer} projection fragment is not an object`);
  const metadata = source.metadata as unknown as AuditPreparationMetadata;
  const backup = join(source.provenance.backupPath, 'owners/backup.json');
  const backupSha256 = sha256(readFileSync(source.readBackup ?? backup));
  requireFact(auditConsumers[consumer].restore !== 'external' || copy, 'external consumer requires an actual isolated restore');
  const preparation = copy ? { ...copy.preparation, buildMs: metadata.buildMs } : undefined;
  const base = { ...fragment };
  if (consumer === 'imports') Object.assign(base, { profile: 'import-outcomes-corpus-v1',
    phase: productRevision === auditBaseline ? 'baseline' : 'candidate', productRevision, selectionDigest: hash(matrix),
    runId: copy!.runId, fixtureRoot: join(checkout, '.temp/fixture'),
    preparation, backup: { manifest: backup, sha256: backupSha256,
      ownerStores: ['fuseki_data', 'postgres_data', 'rustfs_data'], sourceRunId: metadata.sourceRunId },
    authority: { operatorAccount: metadata.grants.find(grant => grant.persona === 'operator')?.accountId,
      exposure: 'platform:catalogue-import', grants: metadata.grants.map(grant => ({ scope: grant.scope, action: grant.action, receipt: grant.result.grantId })) } });
  else if (consumer === 'context') Object.assign(base, { format: 'restored-context-outcomes-v1', runId: copy!.runId,
    corpus: { ...jsonObject(base.corpus), receiptLedger: { path: metadata.receipts.file, sha256: metadata.receipts.sha256 } },
    preparation: { sourceKey: source.key, backup, backupSha256, commandCreated: true,
      buildMs: metadata.buildMs, restoreMs: copy!.preparation.totalMs, smokePassed: true,
      pristineProduct: productRevision, testOverlay: [] } });
  else if (consumer === 'releases') Object.assign(base, { format: 'catalogue-release-media-v1', selection: 'catalogue-release-media',
    preparation: { command: 'bun scripts/goal/goalctl.ts test tests/qa/integration/outcomes/catalogue/releases-and-media.test.ts',
      buildMs: metadata.buildMs, restoreMs: copy!.preparation.totalMs, qaRunId: copy!.runId, backupDigest: backupSha256,
      sourceKey: source.key, baselineProductRevision: auditBaseline,
      sourceOwners: metadata.sourceOwners, restoredOwners: copy!.owners } });
  else if (consumer === 'information') Object.assign(base, { profile: 'catalogue-information-corpus-v1', productBaseline: auditBaseline,
    preparation: { elapsedMs: metadata.buildMs, stopped: true, backup, backupSha256,
      owners: ['access', 'account', 'content', 'graph', 'objects'],
      receipts: [{ file: metadata.receipts.file, sha256: metadata.receipts.sha256 }] } });
  else if (consumer === 'publicDomain') {
    // loadPublicDomainCorpus requires checkout-relative paths, including backup.
    // The retained source still owns its absolute physical backup locator.
    const localBackup = relative(checkout, backup);
    requireFact(localBackup.startsWith(`.temp${sep}`), 'public-domain backup must stay inside this worktree .temp');
    Object.assign(base, { profile: 'catalogue-public-domain-corpus-v1',
      productRevision, backup: localBackup, preparationMs: metadata.buildMs,
      preparationQaRun: metadata.sourceRunId, importedWorks: metadata.originals.map(binding => binding.resource) });
  }
  else if (consumer === 'identity') Object.assign(base, { format: 'identity-reader-corpus-v1',
    recipe: sha256(readFileSync(join(checkout, 'tests/qa/support/identity-reader-fixture.ts'))),
    productRevision: source.provenance.producerRevision, compatibility: loadCompatibility(checkout), backup, buildMs: metadata.buildMs });
  else if (consumer === 'author') {
    const recipe = execRecipeDigest(checkout);
    Object.assign(base, { format: 'author-management-corpus-v1', baselineProduct: auditBaseline,
      buildHead: source.provenance.producerRevision, compatibility: loadCompatibility(checkout).digest,
      recipeDigest: recipe, backup, preparedMs: metadata.buildMs });
  } else {
    // This is a projection of the real retained source, with the same physical
    // custody and backup, not a second producer or a newly invented receipt.
    const specification: SourceInputs = { producer: 'search-intent', version: '1',
      files: { projection: hash(fragment) }, inputs: { corpusOrigin: 'public-api-command-created', source: source.key },
      compatibility: json(loadCompatibility(checkout)) as RetainedOwnerState };
    Object.assign(base, { format: 'rezics-retained-source-v1', key: sourceKey(specification), specification,
      provenance: { ...source.provenance, elapsedMs: metadata.buildMs, backupPath: backup } });
  }
  return json(base);
}

function execRecipeDigest(checkout: string): string {
  // Match the existing author helper's exact file-name/byte recipe identity.
  const chunks: Buffer[] = [];
  for (const name of ['./author-management-fixture.ts', './personas.ts', './persona-fixture-authority.ts'])
    chunks.push(Buffer.from(name), readFileSync(join(checkout, 'tests/qa/support', name)));
  return sha256(Buffer.concat(chunks));
}

function owners(apps: Record<string, string>): Record<string, string> {
  const keys: Record<string, string> = { graph: 'FUSEKI_URL', account: 'ACCOUNT_DATABASE_URL', access: 'ACCESS_DATABASE_URL',
    content: 'CONTENT_DATABASE_URL', relay: 'MAIN_RELAY_DATABASE_URL', objects: 'MAIN_OBJECT_DIRECTORY' };
  return Object.fromEntries(Object.entries(keys).map(([owner, variable]) => {
    requireFact(apps[variable], `restored ${owner} owner address is missing`);
    return [owner, apps[variable]!];
  }));
}

/** Dynamic imports keep inspection and stack-free contract tests independent of
 * Main/Account startup. Physical copying, migrations and authority stay with
 * their current owners. This adapter never executes raw business SQL or RDF. */
export async function liveAuditRuntime(checkout = root, mappers: readonly DatasetNativeMapper[] = []): Promise<AuditRuntime> {
  requireFact(realpathSync(checkout) === realpathSync(root), 'live preparation belongs to this worktree');
  const stack = await import('../../fixture/stack.ts');
  const { restoreCatalogueBackup, retainStoppedOwnerBackup } = await import('../../load/catalogue-backup.ts');
  const { stopCorpusSourcePostgres } = await import('../../load/corpus-backup-driver.ts');
  const { retainedVolumeInventory } = await import('../retained-volume.ts');
  const { recordRetainedPostgresCollations } = await import('../../fixture/runtime-facts.ts');
  const { FusekiClient } = await import('../../../services/main/src/infrastructure/fuseki.ts');
  const { Pool } = await import('pg');
  const { grantFixtureAuthority } = await import('../../../services/main/src/modules/access/fixture-authority.ts');
  const personas = await import('../../../tests/qa/support/personas.ts');
  const { prepareEmptyIdentity } = await import('../../../tests/qa/support/identity-reader-fixture.ts');
  const { importDataset } = await import('../../datasets/import.ts');
  const { readEnv } = await import('../../dev/config.ts');
  const namespace = sha256(checkout), docker = stack.dockerEnvironment();
  const identity = (key: string) => `audit-${hash([namespace, key]).slice(0, 54)}`;
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: checkout, encoding: 'utf8' }).trim();
  requireFact(!execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: checkout, encoding: 'utf8' }).trim(),
    'tracked preparation/test overlays must be committed and identified separately before recording a pristine product revision');
  const open = async (backup: string, realms: AuditRecipe['realms'] | Record<string, RetainedPersonaRealm>,
    budget: FixtureWorkBudget, runId = `audit-${randomUUID().replaceAll('-', '').slice(0, 24)}`,
    observe: (event: RetainedJson) => void = () => {}, originalPersonas?: RetainedPersonaRealm): Promise<AuditSession> => {
    const started = Date.now();
    const signal = AbortSignal.timeout(budget.remaining());
    assertAuditStorage(readEnv(resolve(backup, '../compose.env')));
    const copy = await restoreCatalogueBackup(backup, runId, { signal, resourceClass: 'ordinary' });
    budget.excludeAdmissionWait(copy.admissionWaitMs);
    const environment = { ...copy.apps, REZICS_QA_RUN_ID: runId, REZICS_QA_STACK_TIER: 'integration' };
    const previous = new Map(Object.keys(environment).map(key => [key, process.env[key]]));
    let sessions: Awaited<ReturnType<typeof personas.personaSessions>>[] = [];
    try {
      await stack.stream('bun', ['scripts/load/work-profile-restore-migrations.ts',
        `.temp/stack/rezics-qa-${runId}/apps.env`], docker, undefined, budget.remaining(), signal);
      Object.assign(process.env, environment);
      const ids = Array.isArray(realms) ? realms.map(realm => realm.id) : Object.keys(realms);
      if (Array.isArray(realms)) {
        assertRetainedRealm(originalPersonas);
        const options: NonNullable<Parameters<typeof personas.personaSessions>[1]> = {
          retainedOperator: originalPersonas.identities.operator, retainedAuth: originalPersonas.auth,
          moderatorLifetimeMs: 7 * 86_400_000,
          observeMain: async event => observe(json({ event: 'persona-http', service: 'Main',
            caller: { accountId: event.caller.accountId, actingSubject: event.caller.actingSubject },
            method: event.request.method, path: event.request.path, key: event.request.key,
            body: event.request.body, startedAt: event.requestStartedAt, finishedAt: event.answeredAt,
            status: event.response.status, answer: JSON.parse(event.response.body) })),
          // Account bodies contain credentials. Record status/operation and actual
          // identities through retainedPersonaRealm instead of logging passwords.
          observeAccount: async event => observe(json({ event: 'persona-http', service: 'Account', method: event.request.method,
            path: event.request.path, startedAt: event.requestStartedAt, finishedAt: event.answeredAt, status: event.response.status })),
        };
        for (const realm of realms) sessions.push(await personas.personaSessions(realm.visibility, options));
      } else sessions = await personas.restorePersonaRealms(Object.values(realms));
      const retained = Object.fromEntries(ids.map((id, index) => [id, personas.retainPersonaRealm(sessions[index]!)]));
      const byId = new Map(ids.map((id, index) => [id, sessions[index]!]));
      let closed = false;
      const quiesce = async () => { if (!closed) { await sessions[0]?.close(); closed = true; } };
      const totalMs = Date.now() - started - copy.admissionWaitMs;
      budget.remaining();
      return {
        runId, apps: copy.apps, owners: owners(copy.apps), realms: retained,
        preparation: { ...copy.preparation, totalMs,
          readinessMs: totalMs - copy.preparation.restoreMs - copy.preparation.startupMs },
        async request(realm, persona, method, path, body, key) {
          budget.remaining();
          const session = byId.get(realm)?.[persona];
          requireFact(session, 'request persona does not exist in retained realm');
          const response = await session.main(method, path, body === null ? undefined : body, key ?? undefined);
          return { status: response.status, answer: json(await response.json()) };
        },
        async grant(input) {
          const person = byId.get(input.realm)![input.persona];
          requireFact(person.accountId && person.actingSubject, 'fixture authority requires an authenticated retained identity');
          const pool = new Pool({ connectionString: copy.apps.ACCESS_DATABASE_URL, connectionTimeoutMillis: 2_000 });
          const client = await pool.connect();
          try {
            await client.query('BEGIN');
            const principal = await client.query<{ id: string }>('SELECT id FROM access.principal WHERE account_subject=$1', [person.accountId]);
            requireFact(principal.rows.length === 1, 'fixture identity has no unique supported Access principal');
            const result = await grantFixtureAuthority(client, { scope: input.scope, requireDispatch: true,
              representations: [{ principalId: principal.rows[0]!.id, actor: person.actingSubject, action: input.action, lifetime: input.lifetime }],
              grant: { actor: person.actingSubject, action: input.action, lifetime: input.lifetime } });
            await client.query('COMMIT');
            return { ...input, accountId: person.accountId, actingSubject: person.actingSubject, result };
          } catch (error) { await client.query('ROLLBACK'); throw error; }
          finally { client.release(); await pool.end(); }
        },
        async emptyIdentity(realm) {
          // This owner drains Account's real queue and verifies the real email.
          // It never opens Main for this Account, which is the negative control.
          const values = { ...copy.apps, REZICS_QA_RUN_ID: runId };
          const before = new Map(Object.keys(values).map(key => [key, process.env[key]]));
          Object.assign(process.env, values);
          try { return json(await prepareEmptyIdentity(byId.get(realm)!)); }
          finally { for (const [key, value] of before) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
        },
        async import(input, snapshot, selection) {
          const blockers = auditSelectionBlockers(input, selection);
          if (blockers.length) throw new AuditCorpusBlocked(blockers[0]!.owner, blockers[0]!.stage, blockers[0]!.detail);
          const operator = sessions[0]!.operator;
          requireFact(operator.actingSubject, 'catalogue import requires a retained operator identity');
          // The importer owns journals and may retain media. Give it an isolated
          // byte-identical input tree, never the shared frozen snapshot directory.
          const inputRoot = resolve(checkout, '.temp/audit-corpus/import-inputs', runId);
          const sourceRoot = resolve(checkout, inspectionSourceRoots.get(runId)!);
          const snapshotFile = join(inputRoot, 'snapshots', snapshot.id, 'snapshot.json');
          mkdirSync(dirname(snapshotFile), { recursive: true, mode: 0o700 });
          copyFileSync(auditLocalFile(checkout, join(sourceRoot, 'snapshots', snapshot.id, 'snapshot.json')), snapshotFile, constants.COPYFILE_FICLONE);
          for (const capture of [...snapshot.captures, ...snapshot.images.flatMap(image => image.capture ? [image.capture] : [])]) {
            verifiedBlob(sourceRoot, capture.digest);
            const destination = blobPath(inputRoot, capture.digest);
            mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
            if (!existsSync(destination)) copyFileSync(auditLocalFile(checkout, blobPath(sourceRoot, capture.digest)), destination, constants.COPYFILE_FICLONE);
          }
          const result = await importDataset(inputRoot, snapshot, {
            native: input.native ?? true, relationships: input.native ?? true, selection: input.selection,
            actingSubject: operator.actingSubject,
            mainOrigin: `http://127.0.0.1:${copy.apps.MAIN_PORT}`, webOrigin: `http://127.0.0.1:${copy.apps.MAIN_PORT}`,
            nativeMappers: input.mappers.map(mapper => mappers.find(item => item.id === mapper.id && item.revision === mapper.revision)!),
            api: { async request(method, path, body, key) {
              const response = await operator.main(method, path, body, key);
              return { status: response.status, body: await response.json() as Record<string, unknown> };
            } },
          });
          requireFact(result.completed, 'dataset import did not complete; retained journal is failure evidence');
          const intakeCustody = JSON.parse(readFileSync(auditLocalFile(checkout, result.intakeReceiptsFile), 'utf8')) as unknown;
          return json({ ...result, intakeCustody });
        },
        quiesce,
        async stop() { try { await quiesce(); } finally { await copy.stop(); } },
      };
    } catch (error) { try { await sessions[0]?.close(); } finally { await copy.stop(); } throw error; }
    finally { for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
  };
  const inspectionSourceRoots = new Map<string, string>();
  return {
    revision, mappers,
    async open(inspection, budget, observe) {
      const productBlockers = auditProductBlockers(inspection.recipe.productRevision, revision);
      if (productBlockers.length) throw new AuditCorpusBlocked(productBlockers[0]!.owner, productBlockers[0]!.stage, productBlockers[0]!.detail);
      const session = await open(auditLocalFile(checkout, inspection.originals.backup.file), inspection.recipe.realms, budget, undefined, observe,
        inspection.originals.personas);
      inspectionSourceRoots.set(session.runId, inspection.recipe.sourceRoot);
      return session;
    },
    restore: (backup, metadata, budget, runId) => open(backup, metadata.realms, budget, runId),
    async cut(context, session) {
      await session.quiesce();
      const pool = new Pool({ connectionString: session.apps.ACCESS_DATABASE_URL, connectionTimeoutMillis: 2_000 });
      try { await recordRetainedPostgresCollations(context.backup, sql => pool.query(sql)); }
      finally { await pool.end(); }
      const graph = new FusekiClient(session.apps.FUSEKI_URL!, session.apps.FUSEKI_MAINTENANCE_TOKEN, session.apps.FUSEKI_COMMAND_TOKEN);
      const rdf = stable(await graph.query('SELECT ?g ?s ?p ?o WHERE { GRAPH ?g { ?s ?p ?o } } ORDER BY ?g ?s ?p ?o')) + '\n';
      writeFileSync(join(context.backup, 'rdf-cut.json'), rdf, { mode: 0o600 });
      const signal = AbortSignal.timeout(context.budget.remaining());
      const backup = await retainStoppedOwnerBackup(session.runId, identity(context.key), join(context.backup, 'owners'), Date.now(), {
        resumeSource: false, purpose: 'corpus', signal, stopSourcePostgres: () => stopCorpusSourcePostgres(session.runId, signal),
      });
      const saved = JSON.parse(readFileSync(backup, 'utf8')) as { project: string };
      const volumes = Object.fromEntries(stack.VOLUME_KINDS.map(kind => [kind, retainedVolumeInventory(`${saved.project}_${kind}`, docker)]));
      context.budget.remaining();
      return { backup, rdfDigest: sha256(rdf), ownerState: json({ namespace, project: saved.project, volumes }) as RetainedOwnerState };
    },
    async verify(context, manifest) {
      const state = manifest.integrity.ownerState;
      const backup = JSON.parse(readFileSync(join(context.backup, 'owners/backup.json'), 'utf8')) as { project: string };
      const reasons: string[] = [];
      if (state.namespace !== namespace || state.project !== backup.project || stack.projectRunning(backup.project, docker))
        reasons.push('audit stopped-owner physical custody differs');
      const volumes = state.volumes as RetainedOwnerState;
      for (const kind of stack.VOLUME_KINDS) {
        if (hash(retainedVolumeInventory(`${backup.project}_${kind}`, docker)) !== hash(volumes[kind])) reasons.push(`audit ${kind} inventory differs`);
        context.budget.remaining();
      }
      return reasons;
    },
    async remove(key) {
      requireFact(/^rs-audit-corpus-[a-f0-9]{64}$/u.test(key), 'cannot remove another producer source');
      const pattern = new RegExp(`^(rezics-catalogue-corpus-[a-z0-9][a-z0-9-]{0,30}-${identity(key)}-[a-f0-9]{16})_(?:postgres_data|fuseki_data|rustfs_data)$`);
      const projects = new Map<string, string[]>();
      for (const volume of stack.run('docker', ['volume', 'ls', '-q'], docker).trim().split('\n')) {
        const match = pattern.exec(volume);
        if (match) projects.set(match[1]!, [...projects.get(match[1]!) ?? [], volume]);
      }
      for (const [project, volumes] of projects) {
        requireFact(!stack.projectRunning(project, docker), 'cannot remove a running retained source');
        stack.removeStoppedContainers(project, docker); stack.removeVolumes(volumes, docker);
      }
    },
  };
}

async function selectedAuditSource(checkout: string, recipePath: string, inspected?: AuditInspection) {
  const started = Date.now(), inspection = inspected ?? inspectAuditRecipe(checkout, recipePath);
  if (inspection.blockers.length) {
    const blocker = inspection.blockers[0]!;
    throw new AuditCorpusBlocked(blocker.owner, blocker.stage, blocker.detail);
  }
  const runtime = await liveAuditRuntime(checkout, [datasetMediaMapper(resolve(checkout, inspection.recipe.sourceRoot))]);
  const directory = join(checkout, '.temp/audit-corpus/sources');
  const earlierWorkMs = Date.now() - started + (inspected ? inspected.inspectionMs : 0);
  return { inspection, runtime, store: new RetainedSources(directory),
    adapter: auditCorpusAdapter(checkout, inspection, runtime, directory, Date.now, earlierWorkMs) };
}

export async function preflightAuditCorpus(checkout: string, recipePath = process.env.REZICS_AUDIT_CORPUS_RECIPE ?? '.temp/audit-corpus/recipe.json'): Promise<string> {
  const source = await selectedAuditSource(checkout, recipePath);
  return (await source.store.preflight(source.adapter)).key;
}

/** Restore plan is a pure, reviewable mapping of the actual consumer contracts. */
export function auditRestorePlan(file: string, runId: string) {
  const consumer = auditConsumerForFile(file);
  requireFact(consumer && /^[a-z0-9][a-z0-9-]{0,30}$/u.test(runId), 'select exactly one registered proof file and a valid QA run ID');
  const entry = auditConsumers[consumer];
  return { consumer, restoreOwner: entry.restore, runId,
    manifest: entry.path.replace('{runId}', runId), backupCopies: entry.restore === 'external' ? 1 : 'consumer-owned',
    preparationBudgetMs: auditPreparationBudgetMs, command: ['bun', 'scripts/goal/goalctl.ts', 'test', file] };
}

function writeAuditConsumer(checkout: string, consumer: AuditConsumer, runId: string, manifest: RetainedJson): string {
  const target = join(checkout, '.temp/audit-corpus/consumers', runId, `${consumer}.json`);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  auditLocalFile(checkout, dirname(target));
  writeFileSync(target, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  const entry = auditConsumers[consumer];
  if ('env' in entry) return target;
  const path = join(checkout, entry.path.replace('{runId}', runId));
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  auditLocalFile(checkout, dirname(path));
  // Fixed helper paths are pointers to immutable, per-run manifests. Preserve
  // unmanaged existing evidence and refuse concurrent publishers via its lease.
  try {
    const stat = lstatSync(path);
    requireFact(stat.isSymbolicLink() && auditLocalFile(checkout, path).startsWith(join(checkout, '.temp/audit-corpus/consumers') + sep),
      'fixed consumer path contains unmanaged retained evidence; it was preserved');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const pending = `${path}.pending-${randomUUID()}`;
  symlinkSync(relative(dirname(path), target), pending);
  renameSync(pending, path);
  return path;
}

/** Called by QA before its operation-file clock. The source lease spans the
 * entire proof. Self-restoring helpers receive the same genuine stopped cut;
 * external consumers receive a new owner project and measured smoke readiness. */
export async function prepareAuditQaSelection(checkout: string, file: string, runId: string,
  recipePath = process.env.REZICS_AUDIT_CORPUS_RECIPE ?? '.temp/audit-corpus/recipe.json'): Promise<{ apps: Record<string, string>; environment: Record<string, string>; close(): Promise<void> }> {
  const plan = auditRestorePlan(file, runId);
  requireFact(recipePath, 'REZICS_AUDIT_CORPUS_RECIPE is missing');
  const source = await selectedAuditSource(checkout, recipePath);
  mkdirSync(join(checkout, '.temp/audit-corpus/consumer-leases'), { recursive: true, mode: 0o700 });
  const publicationLease = tryAcquireDirectoryLease(join(checkout, '.temp/audit-corpus/consumer-leases', plan.consumer), { mode: 0o700 });
  if (publicationLease === 'held') throw new AuditCorpusBlocked('audit-consumer-publication', plan.consumer, 'another proof holds this fixed consumer path; no mutable corpus is shared');
  const adapter: RetainedSourceAdapter<RetainedJson, AuditSession | null> = { ...source.adapter,
    restore: async (context, manifest) => plan.restoreOwner === 'external'
      ? source.runtime.restore(join(context.backup, 'owners/backup.json'), manifest.metadata as unknown as AuditPreparationMetadata, context.budget, runId) : null,
    dispose: async candidate => { await candidate?.stop(); } };
  let retained: Awaited<ReturnType<typeof source.store.restore<RetainedJson, AuditSession | null>>> | undefined;
  try {
    retained = await source.store.restore(adapter);
    const metadata = retained.manifest.metadata as unknown as AuditPreparationMetadata;
    const bindings = new Map<string, RetainedJson>(Object.entries(JSON.parse(readFileSync(join(retained.manifest.provenance.backupPath, 'bindings.json'), 'utf8')) as Record<string, RetainedJson>));
    const observed = new Set<string>(JSON.parse(readFileSync(join(retained.manifest.provenance.backupPath, 'observed.json'), 'utf8')) as string[]);
    const previousPreparation = bindings.get('preparation');
    bindings.set('preparation', { ...jsonObject(previousPreparation), buildMs: metadata.buildMs, roundTripMs: metadata.roundTripMs,
      receipts: json(metadata.receipts) });
    const copy = retained.candidate;
    if (copy) {
      const smokeStarted = Date.now(), budget = new FixtureWorkBudget(auditPreparationBudgetMs - retained.elapsedMs);
      const recorder = new AuditRecorder(join(checkout, '.temp/audit-corpus/attempts', `restore-${runId}.jsonl`));
      for (const [key, value] of bindings) recorder.bindings.set(key, value);
      await verifyOriginals(copy, source.inspection, recorder, budget, 'original-proof-restore');
      await readiness(copy, source.inspection.recipe.readiness, recorder, budget, 'proof-restore');
      for (const [name, value] of recorder.bindings) bindings.set(name, value);
      for (const value of recorder.observed) observed.add(value);
      await copy.quiesce();
      copy.preparation.readinessMs += Date.now() - smokeStarted;
      copy.preparation.totalMs = retained.elapsedMs + Date.now() - smokeStarted;
      requireFact(copy.preparation.totalMs <= auditPreparationBudgetMs, 'restore/startup/migrations/smoke exceed 600 seconds');
      bindings.set('restore', json({ runId: copy.runId, owners: copy.owners, preparation: copy.preparation }));
    }
    const fragment = resolveAuditValue(metadata.manifests[plan.consumer], bindings);
    const manifest = projectAuditManifest(plan.consumer, fragment, retained.manifest, copy ?? undefined, checkout, source.runtime.revision);
    assertAuditNativeProvenance(manifest, observed);
    assertAuditGenerationProvenance(manifest, observed);
    assertAuditManifest(plan.consumer, manifest, metadata.originals.map(binding => binding.resource), plan.consumer === 'imports'
      ? { records: auditImportRecordInputs(source.inspection.snapshots), bindings } : undefined);
    const path = writeAuditConsumer(checkout, plan.consumer, runId, manifest);
    const entry = auditConsumers[plan.consumer];
    mkdirSync(join(checkout, '.temp/fixture'), { recursive: true, mode: 0o700 });
    const live = retained;
    return { apps: copy?.apps ?? {}, environment: { REZICS_FIXTURE_ROOT: join(checkout, '.temp/fixture'),
      ...('env' in entry ? { [entry.env]: path } : {}) },
      async close() { try { await live.dispose(); } finally { publicationLease.release(); } } };
  } catch (error) { try { await retained?.dispose(); } finally { publicationLease.release(); } throw error; }
}

export async function prepareAuditCorpus(checkout: string, recipePath: string): Promise<{ key: string; built: boolean; preparationMs: number }> {
  const inspection = inspectAuditRecipe(checkout, recipePath);
  if (inspection.blockers.length) {
    const directory = join(checkout, '.temp/audit-corpus/attempts');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(join(directory, `blocked-${randomUUID()}.json`), JSON.stringify({ format: 'audit-corpus-preparation-blocked-v1',
      recipe: inspection.recipePin, assertionsReached: false, blockers: inspection.blockers }) + '\n', { mode: 0o600, flag: 'wx' });
    const blocker = inspection.blockers[0]!;
    throw new AuditCorpusBlocked(blocker.owner, blocker.stage, blocker.detail);
  }
  const source = await selectedAuditSource(checkout, recipePath, inspection);
  const result = await source.store.prepare(source.adapter);
  return { key: result.manifest.key, built: result.built, preparationMs: result.elapsedMs };
}

if (import.meta.main) {
  const [mode, path, ...extra] = process.argv.slice(2);
  requireFact(path && !extra.length && ['inspect', 'prepare'].includes(mode!), 'use task goal -- prepare-audit inspect|prepare <recipe>');
  if (mode === 'inspect') {
    const result = inspectAuditRecipe(root, path);
    console.log(JSON.stringify({ recipe: result.recipePin, sourcePins: result.sourcePins.length,
      originalBindings: result.originals.bindings.length, selections: [...result.selections].map(([id, selection]) => ({ id, status: selection.status, manifest: selection.manifest })),
      preparationBudgetMs: auditPreparationBudgetMs, blockers: result.blockers, ready: false }, null, 2));
  } else console.log(JSON.stringify(await prepareAuditCorpus(root, path)));
}
