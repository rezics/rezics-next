import { afterEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { FixtureWorkBudget } from '../../fixture/budget.ts';
import { sha256 } from '../../fixture/corpus.ts';
import type { RetainedJson } from '../../fixture/manifest.ts';
import { selectDatasetRoots, type DatasetSelectionBudget } from '../../datasets/selection.ts';
import type { DatasetSnapshot } from '../../datasets/types.ts';
import { auditBaseline, auditConsumers, auditProofFiles, type AuditCommand, type AuditOriginals,
  type AuditRecipe } from '../../../tests/qa/fixtures/audit-corpus-contract.ts';
import type { RetainedPersonaRealm } from '../../../tests/qa/support/personas.ts';
import { commandOnlyIntegrationFiles, isolatedIntegrationFileList } from '../isolated-integration-files.ts';
import { retainedRequirementKinds, retainedRequirements } from '../retained-requirements.ts';
import { sourceKey, type SourceContext } from '../retained-source.ts';
import { assertAuditGenerationProvenance, assertAuditManifest, assertAuditNativeProvenance, assertAuditOriginals, assertAuditRecipe,
  AuditCorpusBlocked, auditBaselineBlockers, auditCorpusAdapter, auditLocalFile, auditPointer, AuditRecorder, auditRestorePlan,
  auditSelectionIsWholeSnapshot, projectAuditManifest, resolveAuditValue,
  type AuditInspection, type AuditRuntime, type AuditSession } from './audit-corpus.ts';

const root = resolve(import.meta.dir, '../../..');
const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });
function directory() {
  mkdirSync(join(root, '.temp'), { recursive: true });
  const path = mkdtempSync(join(root, '.temp/audit-contract-')); temporary.push(path); return path;
}
const id = (number: number) => `https://rezics.com/id/00000000-0000-4000-8000-${number.toString().padStart(12, '0')}`;
function realm(): RetainedPersonaRealm {
  return { realm: id(1), space: id(2), zone: id(3), visibility: 'public',
    auth: { accountOrigin: 'http://127.0.0.1:4001', clientId: 'recorded-client', redirectUris: ['http://127.0.0.1:4002/callback'],
      scope: 'openid profile', mainClientId: 'recorded-main', mainClientSecret: 'sanitized-private-secret' },
    identities: Object.fromEntries(['stranger', 'member', 'owner', 'moderator', 'operator'].map((name, index) => [name,
      { email: `${name}@example.test`, password: 'Sanitized-only-aA7!', accountId: `account-${index}`, actingSubject: id(10 + index) }])) as RetainedPersonaRealm['identities'] };
}
function recipe(): AuditRecipe {
  return { format: 'audit-corpus-recipe-v1', sourceRoot: '.temp/frozen-sources', originals: { file: '.temp/originals.json', sha256: sha256('originals') },
    imports: [], evidence: [{ id: 'source-text', kind: 'text', file: '.temp/source.txt', sha256: sha256('source text'), exact: 'source text',
      url: 'https://www.gutenberg.org/ebooks/11', author: 'Lewis Carroll', rightsBasis: 'public-domain', license: null }],
    realms: [{ id: 'catalogue', visibility: 'public' }, { id: 'independent', visibility: 'public' }, { id: 'concealed', visibility: 'private' }],
    emptyIdentityRealm: 'catalogue',
    grants: [{ realm: 'catalogue', persona: 'operator', scope: 'work:create:catalogue-import', action: 'work.create', lifetime: '7 days' }],
    stages: [], readiness: [
      { id: 'public', realm: 'catalogue', persona: 'visitor', path: '/v1/works/00000000-0000-4000-8000-000000000100', status: 200, equals: { '/work': id(100) } },
      { id: 'hidden', realm: 'catalogue', persona: 'visitor', path: '/v1/works/00000000-0000-4000-8000-000000000999', status: 404, equals: { '/code': 'not_found' } },
    ], manifests: { imports: {}, context: {}, releases: {}, information: {}, publicDomain: {}, identity: {}, author: {}, search: {} } };
}
function session(overrides: Partial<AuditSession> = {}): AuditSession {
  return { runId: 'audit-unit', apps: {}, owners: { graph: 'isolated-graph' },
    realms: { catalogue: realm() }, preparation: { restoreMs: 10, startupMs: 20, readinessMs: 30, totalMs: 60 },
    async request() { throw new Error('Unexpected HTTP request'); }, async grant() { throw new Error('Unexpected grant'); },
    async emptyIdentity() { return { email: 'empty@example.test', password: 'Sanitized-aA7!', accountId: 'empty-account' }; },
    async import() { throw new Error('Unexpected import'); }, async quiesce() {}, async stop() {}, ...overrides };
}
const command: AuditCommand = { id: 'create', realm: 'catalogue', persona: 'operator', method: 'POST', path: '/v1/works',
  body: { profile: 'metadata-only-v1', title: 'Alice’s Adventures in Wonderland', language: 'en' }, key: 'audit-source-work-create', status: 201, evidence: ['source-text'] };
function events(file: string): Record<string, unknown>[] { return readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>); }

test('later fixture pins block preparation without substituting the original product baseline', () => {
  expect(auditBaselineBlockers({ imports: auditBaseline })).toEqual([]);
  expect(auditBaselineBlockers({ publicDomain: '79be80d4d0e1cad1639b6a65e8f0795d6a95929a' })).toEqual([
    expect.objectContaining({ owner: 'audit-baseline-contract', stage: 'publicDomain',
      detail: expect.stringContaining(auditBaseline) }),
  ]);
});

test('receipt references distinguish absent, null, escaped names and owner native IDs', () => {
  const bindings = new Map<string, RetainedJson>([['command:create', { answer: { 'a/b': [null, { '~id': id(100) }] } }]]);
  const ref = { $audit: 'ref', from: 'command:create', pointer: '/answer/a~1b/1/~0id' };
  expect(resolveAuditValue({ $audit: 'tail', value: ref }, bindings)).toBe(id(100).slice(-36));
  expect(resolveAuditValue({ $audit: 'concat', values: ['/v1/works/', { $audit: 'tail', value: ref }] }, bindings))
    .toBe(`/v1/works/${id(100).slice(-36)}`);
  expect(auditPointer({ value: null }, '/value')).toBeNull();
  for (const pointer of ['/absent', '/constructor', '/a~2b']) expect(() => auditPointer({}, pointer)).toThrow();
  expect(() => resolveAuditValue({ $audit: 'ref', from: 'command:failed', pointer: '' }, bindings)).toThrow('unobserved binding');
  expect(() => resolveAuditValue({ $audit: 'ref', from: 'command:create', pointer: '', fallback: {} }, bindings)).toThrow('malformed receipt');
});

test('successful commands retain the exact caller, request key, response and binding', async () => {
  const recorder = new AuditRecorder(join(directory(), 'receipts.jsonl'));
  const seen: unknown[][] = [];
  const owner = session({ async request(...args) { seen.push(args); return { status: 201, answer: { work: id(100), revision: id(101), sourcePosition: { dataEpoch: 'actual-epoch', sequence: '17' } } }; } });
  await recorder.command(owner, command, 'source-intake');
  expect(seen).toEqual([['catalogue', 'operator', 'POST', '/v1/works', command.body, command.key]]);
  const finished = events(recorder.file).find(event => event.event === 'command-finished')!;
  expect(finished).toMatchObject({ event: 'command-finished', status: 201, key: command.key,
    caller: { accountId: 'account-4', actingSubject: id(14) }, answer: { work: id(100) } });
  expect(resolveAuditValue({ $audit: 'ref', from: 'command:create', pointer: '/answer/revision' }, recorder.bindings)).toBe(id(101));
  assertAuditNativeProvenance({ work: id(100) }, recorder.observed);
  assertAuditGenerationProvenance({ sourcePosition: { dataEpoch: 'actual-epoch', sequence: '17' } }, recorder.observed);
  expect(() => assertAuditNativeProvenance({ work: id(999) }, recorder.observed)).toThrow('no observed');
  expect(() => assertAuditGenerationProvenance({ modelGeneration: 'invented-generation' }, recorder.observed)).toThrow('no observed');
});

test('search evidence projects independently checksummed single-command JSON from successful receipts', async () => {
  const recorder = new AuditRecorder(join(directory(), 'commands.jsonl'));
  const answer = { work: id(100), revision: id(101) };
  const owner = session({ async request() { return { status: 201, answer }; } });
  await recorder.command(owner, command, 'search-records');
  const evidence = resolveAuditValue({ $audit: 'ref', from: 'receipt:create', pointer: '' }, recorder.bindings) as { path: string; sha256: string };
  const bytes = readFileSync(evidence.path);
  expect(sha256(bytes)).toBe(evidence.sha256);
  expect(statSync(evidence.path).mode & 0o077).toBe(0);
  expect(JSON.parse(bytes.toString())).toEqual(recorder.bindings.get('command:create'));
  expect(JSON.parse(bytes.toString())).toMatchObject({ method: 'POST', path: '/v1/works', status: 201,
    key: command.key, answer, caller: { accountId: 'account-4', actingSubject: id(14) } });
  expect(recorder.receiptPins).toEqual([{ file: evidence.path, sha256: evidence.sha256 }]);
  expect(events(recorder.file).at(-1)).toMatchObject({ event: 'command-evidence-retained', id: command.id, ...evidence });
  await recorder.command(owner, { ...command, id: 'second', key: 'second-retained-key' }, 'search-records');
  expect(readFileSync(evidence.path)).toEqual(bytes);
  expect(new Set(recorder.receiptPins.map(pin => pin.file)).size).toBe(2);
  for (const pin of recorder.receiptPins) expect(JSON.parse(readFileSync(pin.file, 'utf8')).status).toBe(201);
  expect(() => resolveAuditValue({ $audit: 'ref', from: 'receipt:unexecuted', pointer: '' }, recorder.bindings)).toThrow('unobserved binding');
});

test('read receipts preserve concealed responses and transport failures with their actual callers', async () => {
  const recorder = new AuditRecorder(join(directory(), 'reads.jsonl'));
  const input = { id: 'hidden', realm: 'catalogue', persona: 'visitor' as const, path: '/v1/works/00000000-0000-4000-8000-000000000999' };
  const missing = session({ async request() { return { status: 404, answer: { code: 'not_found', modelGeneration: 'observed-generation' } }; } });
  await expect(recorder.read(missing, input, 'proof-restore')).resolves.toMatchObject({ status: 404 });
  expect(events(recorder.file).at(-1)).toMatchObject({ event: 'read-finished', phase: 'proof-restore', status: 404,
    caller: { realm: 'catalogue', persona: 'visitor', accountId: null, actingSubject: null },
    answer: { code: 'not_found', modelGeneration: 'observed-generation' } });
  await expect(recorder.read(session(), { ...input, persona: 'operator' }, 'originals')).rejects.toThrow('Unexpected HTTP');
  expect(events(recorder.file).at(-1)).toMatchObject({ event: 'read-failed', status: null, answer: null,
    caller: { accountId: 'account-4', actingSubject: id(14) } });
  expect(recorder.bindings.size).toBe(0);
});

for (const failure of ['403', 'transport'] as const) test(`${failure} preserves failure evidence without a successful binding or retry`, async () => {
  const recorder = new AuditRecorder(join(directory(), 'receipts.jsonl')); let calls = 0;
  const owner = session({ async request() { calls++; if (failure === 'transport') throw new Error('lost connection'); return { status: 403, answer: { code: 'forbidden' } }; } });
  await expect(recorder.command(owner, command, 'source-intake')).rejects.toThrow(failure === '403' ? 'observed 403' : 'lost connection');
  expect(calls).toBe(1); expect(recorder.bindings.has('command:create')).toBe(false);
  expect(recorder.bindings.has('receipt:create')).toBe(false);
  expect(recorder.receiptPins).toEqual([]);
  expect(readdirSync(resolve(recorder.file, '..'))).toEqual(['receipts.jsonl']);
  const answer = events(recorder.file).at(-1)!;
  expect(answer.status).toBe(failure === '403' ? 403 : null);
  expect(answer.answer).toEqual(failure === '403' ? { code: 'forbidden' } : null);
  expect(answer.event).toBe(failure === '403' ? 'command-finished' : 'command-failed');
});

test('preparation rejects direct-owner paths and query-under-proof oracles before HTTP', async () => {
  for (const path of ['/v1/query', '/v1/search', '/sparql', 'http://127.0.0.1:3030/update', '/v1/works/../sparql']) {
    const recorder = new AuditRecorder(join(directory(), 'receipts.jsonl'));
    await expect(recorder.command(session(), { ...command, path }, 'intake')).rejects.toThrow();
    expect(readFileSync(recorder.file, 'utf8')).toBe('');
  }
});

test('recipe admission rejects implicit mandates, unknown dependencies and replay-key reuse', () => {
  assertAuditRecipe(recipe());
  const absent = recipe(); absent.grants = [];
  expect(() => assertAuditRecipe(absent)).toThrow('mandate');
  const unordered = recipe(); unordered.stages = [{ id: 'native', requires: ['intake'], commands: [] }];
  expect(() => assertAuditRecipe(unordered)).toThrow('out of order');
  const duplicate = recipe(); duplicate.stages = [{ id: 'intake', requires: [], commands: [command, { ...command, id: 'again' }] }];
  expect(() => assertAuditRecipe(duplicate)).toThrow('replay key');
  const unknownEvidence = recipe(); unknownEvidence.stages = [{ id: 'intake', requires: [], commands: [{ ...command, evidence: ['unretained'] }] }];
  expect(() => assertAuditRecipe(unknownEvidence)).toThrow('qualified source');
});

test('a bounded view cannot silently fall back to parent, alter roles or borrow the parent digest', () => {
  const snapshot: DatasetSnapshot = { format: 'rezics-local-dataset-v1', id: 'dataset-retained', digest: sha256('retained-parent'), createdAt: '2026-10-02T14:31:36.684Z',
    captures: [], images: [], sources: [{ provider: 'vndb', roots: ['vndb:vn:v11', 'vndb:vn:v7'], images: [], scope: {},
      records: ['v11', 'v7'].map(externalId => ({ key: `vndb:vn:${externalId}`, provider: 'vndb', kind: 'vn', externalId,
        title: externalId === 'v11' ? 'Fate/stay night' : 'Tsukihime', language: 'ja', sourceUrl: `https://vndb.org/${externalId}`, data: {}, native: 'work' })), edges: [] }] };
  const before = JSON.stringify(snapshot);
  const budget: DatasetSelectionBudget = { maxInputItems: 100, maxRecords: 20, maxEdges: 20, maxImages: 20, maxJsonBytes: 100_000, maxMediaBytes: 1_000_000 };
  const bounded = selectDatasetRoots(snapshot, { roots: ['vndb:vn:v11'], budget });
  expect(bounded.status).toBe('complete'); expect(auditSelectionIsWholeSnapshot(snapshot, bounded)).toBe(false);
  const whole = selectDatasetRoots(snapshot, { roots: snapshot.sources[0]!.roots, budget });
  expect(whole.status).toBe('complete'); expect(auditSelectionIsWholeSnapshot(snapshot, whole)).toBe(true);
  const changed = structuredClone(whole);
  if (changed.selection) changed.selection.sources[0]!.scope = { originalRole: 'lost' };
  expect(auditSelectionIsWholeSnapshot(snapshot, changed)).toBe(false);
  expect(JSON.stringify(snapshot)).toBe(before);
});

test('every actual consumer has isolated closed-writer QA and a read-only retained preflight', () => {
  expect(new Set(auditProofFiles).size).toBe(auditProofFiles.length);
  for (const file of auditProofFiles) {
    expect(existsSync(join(root, file))).toBe(true);
    expect((isolatedIntegrationFileList as readonly string[]).includes(file)).toBe(true);
    expect(commandOnlyIntegrationFiles.has(file)).toBe(true);
    expect(retainedRequirementKinds(root, [file])).toContain('audit');
    const requirement = retainedRequirements(root, [file]).find(item => item.source === 'audit')!;
    expect(requirement.preparedByRun).toBeUndefined();
    expect(requirement.build).toBe('task goal -- prepare-audit prepare');
    const plan = auditRestorePlan(file, 'audit-one');
    expect(plan.preparationBudgetMs).toBe(600_000);
    expect(plan.backupCopies).toBe(auditConsumers[plan.consumer].restore === 'external' ? 1 : 'consumer-owned');
    expect(plan.command).toEqual(['bun', 'scripts/goal/goalctl.ts', 'test', file]);
  }
  expect(() => auditRestorePlan('tests/qa/integration/unregistered.test.ts', 'audit-one')).toThrow();
  expect(() => auditRestorePlan(auditProofFiles[0]!, '../another-worker')).toThrow();
});

test('source paths cannot read another checkout through traversal or symlinks', () => {
  const base = directory(), local = join(base, '.temp'); mkdirSync(local);
  const file = join(local, 'source.txt'); writeFileSync(file, 'retained bytes');
  expect(auditLocalFile(base, file)).toBe(file);
  const other = directory(), outside = join(other, 'source.txt'); writeFileSync(outside, 'another worker');
  symlinkSync(outside, join(local, 'borrowed.txt'));
  expect(() => auditLocalFile(base, join(local, 'borrowed.txt'))).toThrow('escapes');
});

test('projection timing, backup custody and restore addresses cannot be supplied by templates', () => {
  const base = directory(), backup = join(base, 'backup.json'); writeFileSync(backup, '{"format":"command-catalogue-backup-v1"}');
  const metadata = { buildMs: 455, sourceRunId: 'audit-source', grants: [{ persona: 'operator', accountId: 'account-4',
    scope: 'work:create:catalogue-import', action: 'work.create', result: { grantId: 'actual-grant' } }] };
  const source = { key: 'rs-audit-corpus-actual', metadata, readBackup: backup,
    provenance: { producerRevision: 'producer-head', elapsedMs: 455, backupPath: join(base, 'retained/backup') } };
  const copy = session();
  const projected = projectAuditManifest('imports', { productRevision: 'fabricated', runId: 'shared', preparation: { totalMs: 0 } }, source, copy, root, auditBaseline);
  expect(projected).toMatchObject({ productRevision: auditBaseline, runId: copy.runId,
    preparation: { buildMs: 455, totalMs: 60 }, backup: { sha256: sha256(readFileSync(backup)), sourceRunId: 'audit-source' } });
  expect(() => projectAuditManifest('imports', {}, source, undefined, root, auditBaseline)).toThrow('actual isolated restore');
  expect(() => assertAuditManifest('imports', projected, [])).toThrow('consumer contract');
});

test('the import consumer cannot receive a manifest without its frozen source root', () => {
  const corpus = { profile: 'import-outcomes-corpus-v1', phase: 'candidate', productRevision: 'fixed-head',
    selectionDigest: sha256('independent-matrix'), runId: 'isolated-import', fixtureRoot: '.temp/fixture',
    realm: realm(), backup: {}, preparation: {}, authority: {}, targets: {}, relations: {}, sources: {},
    selections: [{ name: 'fate-goldberg-v1', commands: [] }], hidden: {}, music: {},
    refresh: { sourceKey: 'vndb:vn:v11', baseConversion: id(100), candidateConversion: id(101), command: {},
      oldGeneration: 'observed-old', newGeneration: 'observed-new' } };
  expect(() => assertAuditManifest('imports', corpus, [])).toThrow('consumer contract');
  for (const sourceRoot of ['', null]) expect(() => assertAuditManifest('imports', { ...corpus, sourceRoot }, [])).toThrow('sourceRoot');
  expect(() => assertAuditManifest('imports', { ...corpus, sourceRoot: '.temp/frozen-sources' }, [])).not.toThrow();
});

test('public-domain backup projections retain the same cut using the relative path required by its parser', () => {
  const base = directory(), backupDirectory = join(base, 'backup'), backup = join(backupDirectory, 'owners/backup.json');
  mkdirSync(join(backupDirectory, 'owners'), { recursive: true });
  writeFileSync(backup, '{"format":"command-catalogue-backup-v1"}');
  const originals = inspection().originals.bindings.map(binding => ({ ...binding }));
  const source = { key: 'rs-audit-corpus-actual', metadata: { buildMs: 455, sourceRunId: 'audit-source', originals },
    provenance: { producerRevision: auditBaseline, elapsedMs: 455, backupPath: backupDirectory } };
  const projected = projectAuditManifest('publicDomain', { backup: '/another-checkout/backup.json' }, source, undefined, root, auditBaseline) as { backup: string; importedWorks: string[] };
  expect(isAbsolute(projected.backup)).toBe(false);
  expect(projected.backup).toStartWith('.temp/');
  expect(auditLocalFile(root, projected.backup)).toBe(backup);
  expect(projected.importedWorks).toEqual(originals.map(binding => binding.resource));
  const outside = { ...source, readBackup: backup, provenance: { ...source.provenance, backupPath: '/tmp/outside-audit' } };
  expect(() => projectAuditManifest('publicDomain', {}, outside, undefined, root, auditBaseline)).toThrow('inside this worktree .temp');
});

function inspection(): AuditInspection {
  const originals: AuditOriginals = { format: 'audit-original-bindings-v1', backup: { file: '.temp/original-backup.json', sha256: sha256('backup') },
    personas: realm(),
    bindings: Array.from({ length: 113 }, (_, index) => ({ sourceKey: `retained:${index}`, resource: id(100 + index), mainVersion: id(300 + index), revision: id(500 + index),
      readPath: `/v1/works/${id(100 + index).slice(-36)}`, resourcePointer: '/work', mainVersionPointer: '/mainVersion', revisionPointer: '/revision' })) };
  return { recipe: recipe(), recipePin: { file: '.temp/private-recipe.json', sha256: sha256(randomUUID()) }, originals,
    snapshots: new Map(), selections: new Map(), sourcePins: [], blockers: [], inspectionMs: 0 };
}

test('a retained catalogue requires its original operator and exact native ledger before preparation', () => {
  const original = inspection().originals;
  assertAuditOriginals(original);
  const noOperator = structuredClone(original);
  Reflect.deleteProperty(noOperator.personas.identities, 'operator');
  expect(() => assertAuditOriginals(noOperator)).toThrow('identity is incomplete');
  const duplicate = structuredClone(original);
  duplicate.bindings[1]!.resource = duplicate.bindings[0]!.resource;
  expect(() => assertAuditOriginals(duplicate)).toThrow('resource binding is duplicated');
});

test('earlier source inspection consumes the existing budget and cannot open owners after expiry', async () => {
  let now = 0;
  const budget = new FixtureWorkBudget(600_000, () => now);
  budget.includeElapsedWork(100);
  now = 150; budget.excludeAdmissionWait(50);
  expect(budget.timing()).toEqual({ elapsedMs: 200, admissionWaitMs: 50 });
  expect(budget.remaining()).toBe(599_800);
  for (const invalid of [-1, Infinity, NaN]) expect(() => budget.includeElapsedWork(invalid)).toThrow('nonnegative finite');

  const input = inspection(); input.inspectionMs = 600_000;
  const runtime = { async open() { throw new Error('must never open'); } } as unknown as AuditRuntime;
  const adapter = auditCorpusAdapter(root, input, runtime, join(directory(), 'sources'));
  const context: SourceContext = { key: sourceKey(adapter.specification), directory: directory(), backup: directory(), budget: new FixtureWorkBudget(600_000) };
  await expect(adapter.build(context)).rejects.toThrow('exceeded 600 seconds');
  const attemptRoot = join(root, '.temp/audit-corpus/attempts');
  const attempts = readdirSync(attemptRoot).filter(file => file.startsWith(`${context.key}-`));
  expect(attempts.length).toBe(1);
  const path = join(attemptRoot, attempts[0]!); temporary.push(path);
  expect(events(path).at(-1)).toMatchObject({ event: 'preparation-failed', assertionsReached: false });
});

test('one stopped cut is round-tripped, and failed manifest validation retains evidence without publishing ready', async () => {
  const base = directory(), input = inspection(), calls: string[] = [];
  input.recipe.stages = [{ id: 'search-records', requires: [], commands: [command] }];
  const request: AuditSession['request'] = async (_realm, _persona, method, path): Promise<{ status: number; answer: RetainedJson }> => {
    if (method === 'POST') return { status: 201, answer: { work: id(100), revision: id(500) } };
    const original = input.originals.bindings.find(binding => binding.readPath === path);
    return original ? { status: 200, answer: { work: original.resource, mainVersion: original.mainVersion, revision: original.revision } }
      : { status: 404, answer: { code: 'not_found' } };
  };
  const source = session({ request, async grant(grant) { return { ...grant, accountId: 'account-4', actingSubject: id(14), result: { grantId: id(900), representationIds: [] } }; },
    async quiesce() { calls.push('source-quiesced'); }, async stop() { calls.push('source-stopped'); } });
  const smoke = session({ request, async stop() { calls.push('smoke-stopped'); } });
  const runtime: AuditRuntime = { revision: 'product-head', mappers: [], async open() { calls.push('open'); return source; },
    async cut(context) { expect(calls.at(-1)).toBe('source-quiesced'); calls.push('cut');
      const backup = join(context.backup, 'owners/backup.json'); mkdirSync(join(context.backup, 'owners')); writeFileSync(backup, '{}');
      return { backup, rdfDigest: sha256('rdf'), ownerState: {} }; },
    async restore(_backup, metadata) {
      calls.push('round-trip');
      expect(metadata.sourcePins).toHaveLength(1);
      for (const pin of metadata.sourcePins) {
        temporary.push(pin.file);
        expect(sha256(readFileSync(pin.file))).toBe(pin.sha256);
        expect(JSON.parse(readFileSync(pin.file, 'utf8')).status).toBe(201);
      }
      return smoke;
    }, async verify() { return []; }, async remove() {} };
  const adapter = auditCorpusAdapter(root, input, runtime, join(base, 'sources'));
  const key = sourceKey(adapter.specification), backup = join(base, 'pending/backup'); mkdirSync(backup, { recursive: true });
  const context: SourceContext = { key, directory: join(base, 'pending'), backup, budget: new FixtureWorkBudget(600_000) };
  await expect(adapter.build(context)).rejects.toThrow('consumer contract');
  expect(calls).toEqual(['open', 'source-quiesced', 'cut', 'round-trip', 'smoke-stopped', 'source-stopped']);
  expect(existsSync(join(base, 'sources', key, 'manifest.json'))).toBe(false);
  const attemptRoot = join(root, '.temp/audit-corpus/attempts');
  const attempts = readdirSync(attemptRoot).filter(file => file.startsWith(`${key}-`) && file.endsWith('.jsonl'));
  expect(attempts.length).toBe(1);
  for (const file of attempts) { const path = join(attemptRoot, file); temporary.push(path);
    expect(events(path).at(-1)).toMatchObject({ event: 'preparation-failed', assertionsReached: false }); }
});

test('a missing API owner blocks before opening any stack or mutating the original backup', async () => {
  const input = inspection(); input.blockers.push({ owner: 'dataset-import-selection', stage: 'frozen-vndb', detail: 'selected-view input unavailable' });
  const runtime = { async open() { throw new Error('must never open'); } } as unknown as AuditRuntime;
  const adapter = auditCorpusAdapter(root, input, runtime, join(directory(), 'sources'));
  const context: SourceContext = { key: sourceKey(adapter.specification), directory: directory(), backup: directory(), budget: new FixtureWorkBudget(600_000) };
  try { await adapter.build(context); throw new Error('expected blocker'); }
  catch (error) { expect(error).toBeInstanceOf(AuditCorpusBlocked); expect(error).toMatchObject({ owner: 'dataset-import-selection', assertionsReached: false }); }
});
