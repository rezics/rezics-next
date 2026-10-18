import { afterEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { FixtureWorkBudget } from '../../fixture/budget.ts';
import { sha256 } from '../../fixture/corpus.ts';
import type { RetainedJson } from '../../fixture/manifest.ts';
import { canonicalJson } from '../../lib/canonical-json.ts';
import { intakeChunks } from '../../datasets/import.ts';
import { selectDatasetRoots, type DatasetSelectionBudget } from '../../datasets/selection.ts';
import type { DatasetRecord, DatasetSnapshot } from '../../datasets/types.ts';
import { retainedAdmissionCases, type RetainedRecordBinding, type RetainedRecordInput } from '../../../tests/qa/fixtures/catalogue/import-admission-contract.ts';
import type { ImportCorpus } from '../../../tests/qa/support/import-outcomes.ts';
import { auditBaseline, auditConsumers, auditProofFiles, type AuditCommand, type AuditOriginals,
  type AuditRecipe } from '../../../tests/qa/fixtures/audit-corpus-contract.ts';
import type { RetainedPersonaRealm } from '../../../tests/qa/support/personas.ts';
import { commandOnlyIntegrationFiles, isolatedIntegrationFileList } from '../isolated-integration-files.ts';
import { retainedRequirementKinds, retainedRequirements } from '../retained-requirements.ts';
import { sourceKey, type SourceContext } from '../retained-source.ts';
import { assertAuditGenerationProvenance, assertAuditManifest, assertAuditNativeProvenance, assertAuditOriginals, assertAuditRecipe,
  AuditCorpusBlocked, auditBaselineBlockers, auditCorpusAdapter, auditLocalFile, auditPointer, AuditRecorder, auditRestorePlan,
  auditSelectionIsWholeSnapshot, projectAuditManifest, resolveAuditValue,
  type AuditImportInputs, type AuditInspection, type AuditRuntime, type AuditSession } from './audit-corpus.ts';

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

test('the import consumer cannot receive a manifest without its frozen source root and input receipts', async () => {
  const { corpus, inputs } = await importInputs();
  const absent = structuredClone(corpus); Reflect.deleteProperty(absent, 'sourceRoot');
  expect(() => assertAuditManifest('imports', absent, [], inputs)).toThrow('consumer contract');
  for (const sourceRoot of ['', null]) expect(() => assertAuditManifest('imports', { ...corpus, sourceRoot }, [], inputs)).toThrow('sourceRoot');
  expect(() => assertAuditManifest('imports', corpus, [])).toThrow('frozen records and actual command bindings');
  expect(() => assertAuditManifest('imports', corpus, [], inputs)).not.toThrow();
});

const recordHash = (value: unknown) => sha256(canonicalJson(value));
const bangumi = 'bangumi:subject:1014';
// Sanitized counterexamples exercise the producer only. These are neither
// frozen provider captures nor receipts from a prepared/live audit corpus.
async function importInputs() {
  const recorder = new AuditRecorder(join(directory(), 'import-receipts.jsonl'));
  const records = new Map<string, Pick<RetainedRecordInput, 'identity' | 'snapshot' | 'record' | 'recordDigest'>>();
  const sources: ImportCorpus['sources'] = {};
  const targets: ImportCorpus['targets'] = {};
  const retain = async (name: string, path: string, body: RetainedJson, answer: RetainedJson, method: 'POST' | 'GET' = 'POST') => {
    await recorder.command(session({ async request() { return { status: method === 'GET' ? 200 : 201, answer }; } }),
      { ...command, id: name, path, body, method, key: method === 'GET' ? null : `unit-${name}`, status: method === 'GET' ? 200 : 201 }, 'import-inputs');
  };
  for (const [sourceIndex, key] of retainedAdmissionCases.entries()) {
    const [provider, kind, externalId] = key.split(':');
    const sourceName = key === bangumi ? 'とある魔術の禁書目録' : key.startsWith('vndb:') ? 'Fate/stay night' : 'Goldberg Variations';
    const data = key === bangumi ? { api_subject: { id: 1014, name: sourceName, summary: '一行目\n  二行目' } }
      : { name: sourceName,
        alias: 'first alias\r\n第二名', amount: '12345678901234567890.0100', date: '1982-10',
        ...(kind === 'artist' ? { annotation: '長い原文\n'.repeat(7_000) } : {}) };
    const record: DatasetRecord = { key, provider: provider as DatasetRecord['provider'], kind: kind!, externalId: externalId!,
      title: `Normalized ${sourceName}`, language: 'JA', native: 'work', sourceUrl: 'https://example.invalid/retained', data };
    const frozen = { identity: { key, provider: record.provider, namespace: record.kind, externalId: record.externalId },
      snapshot: { id: `unit-${provider}`, digest: recordHash(`${provider}-logical`), fileSha256: recordHash(`${provider}-file`) },
      record, recordDigest: recordHash(record) };
    records.set(key, frozen);
    const buffers = intakeChunks(key === bangumi ? record.data.api_subject : record.data);
    const parts: ImportCorpus['sources'][string]['parts'] = [];
    for (const [index, bytes] of buffers.entries()) {
      const name = `intake-${sourceIndex}-${index}`;
      const body = { profile: 'source-manual-intake-v1', provider: record.provider,
        namespace: buffers.length === 1 ? record.kind : `${record.kind}-dataset-part`,
        externalId: buffers.length === 1 ? record.externalId : `${record.externalId}:part:${index}`,
        sourceRevision: frozen.snapshot.digest, mediaType: 'application/json', retention: 'retained', rawBytesBase64: bytes.toString('base64'),
        coverage: { scope: 'unit-frozen-record', complete: buffers.length === 1, omittedFields: [] },
        rightsEvidence: { basis: 'unknown', note: 'Sanitized unit input, not a publication rights claim.' } };
      await retain(name, '/v1/sources/intakes', body,
        { observation: { ...body, state: 'staged', record: id(1_000 + sourceIndex * 100 + index),
          observation: id(2_000 + sourceIndex * 100 + index), byteDigest: sha256(bytes), byteLength: bytes.length } });
      const ref = (pointer: string) => ({ $audit: 'ref', from: `command:${name}`, pointer });
      parts.push(resolveAuditValue({ record: ref('/answer/observation/record'), observation: ref('/answer/observation/observation'),
        rawDigest: ref('/answer/observation/byteDigest'), rawBytesBase64: ref('/body/rawBytesBase64') }, recorder.bindings) as typeof parts[number]);
    }
    const first = JSON.parse(buffers[0]!.toString()) as Record<string, RetainedJson>;
    sources[key] = { record: parts[0]!.record!, observation: parts[0]!.observation, parts,
      retainedRequest: { profile: 'source-retained-record-conversion-v1', mappingRevision: 'unit-requested-map-no-registration-claim',
        retained: { ...frozen, intakes: parts.map((part, index) => ({ index, record: part.record!, observation: part.observation, byteDigest: part.rawDigest })),
          payload: first.format === 'rezics-dataset-chunk-v1'
            ? { format: 'rezics-dataset-chunk-v1', byteDigest: first.digest as string, byteLength: first.byteLength as number }
            : { format: 'json', byteDigest: sha256(buffers[0]!), byteLength: buffers[0]!.length } } } };
    targets[key] = { resource: id(3_000 + sourceIndex), revision: id(4_000 + sourceIndex), kind: record.kind };
  }
  const source = sources[bangumi]!;
  source.conversion = id(5_000); source.proposal = id(5_001);
  await retain('bangumi-conversion', `/v1/sources/observations/${source.observation.slice(-36)}/conversions`,
    { profile: 'source-mapped-conversion-v1', mappingRevision: 'bangumi-subject-map-v1' },
    { conversion: { profile: 'source-mapped-conversion-v1', state: 'staged', conversion: source.conversion,
      observation: source.observation, mappingRevision: 'bangumi-subject-map-v1', sourceDigest: source.parts[0]!.rawDigest } });
  await retain('bangumi-proposal', `/v1/sources/conversions/${source.conversion.slice(-36)}/proposals/native-work`,
    { profile: 'source-native-work-proposal-v1' }, { proposal: { profile: 'source-native-work-proposal-v1',
      state: 'proposed', proposal: source.proposal, record: source.record, observation: source.observation, conversion: source.conversion } });
  const corpus = { profile: 'import-outcomes-corpus-v1', phase: 'candidate', productRevision: 'unit-fixed-head',
    selectionDigest: sha256('unit-matrix'), runId: 'unit-isolated-import', fixtureRoot: '.temp/fixture', sourceRoot: '.temp/unit-frozen-sources',
    realm: realm(), backup: {}, preparation: {}, authority: {}, targets, relations: {}, sources,
    selections: ['fate-goldberg-v1', 'index-goldberg-v1'].map(name => ({ name, commands: [] })), hidden: {}, music: {},
    refresh: { sourceKey: bangumi, baseConversion: source.conversion, candidateConversion: id(5_002), command: {},
      oldGeneration: 'unit-observed-old', newGeneration: 'unit-observed-new' } };
  return { corpus, recorder, retain, inputs: { records, bindings: recorder.bindings } satisfies AuditImportInputs };
}

test('import inputs permit absent proposed results but keep real Bangumi editorial and authority conversions', async () => {
  const { corpus, inputs } = await importInputs();
  for (const key of retainedAdmissionCases.filter(key => key !== bangumi)) expect(corpus.sources[key]!.conversion).toBeUndefined();
  expect(() => assertAuditManifest('imports', corpus, [], inputs)).not.toThrow();
  for (const field of ['conversion', 'proposal']) {
    const copy = structuredClone(corpus); Reflect.deleteProperty(copy.sources[bangumi]!, field);
    expect(() => assertAuditManifest('imports', copy, [], inputs)).toThrow(field === 'conversion' ? 'proposal' : 'Bangumi editorial');
  }
  for (const key of retainedAdmissionCases) {
    const copy = structuredClone(corpus); Reflect.deleteProperty(copy.sources[key]!, 'retainedRequest');
    expect(() => assertAuditManifest('imports', copy, [], inputs)).toThrow(`missing exact retainedRequest: ${key}`);
  }
});

test('retained requests keep the whole record, original identity and independent snapshot/record/raw-byte digests', async () => {
  const { corpus, inputs } = await importInputs();
  const key = retainedAdmissionCases[0], request = corpus.sources[key]!.retainedRequest!;
  const mutate = (change: (retained: typeof request.retained) => void) => {
    const copy = structuredClone(corpus); change(copy.sources[key]!.retainedRequest!.retained);
    expect(() => assertAuditManifest('imports', copy, [], inputs)).toThrow('retainedRequest');
  };
  mutate(input => { input.record.title = 'Changed normalized field outside data'; });
  mutate(input => { input.record.language = 'ja'; });
  mutate(input => { input.record.native = 'source-only'; });
  mutate(input => { input.identity.namespace = 'vn-dataset-part'; });
  mutate(input => { input.identity.externalId += ':part:0'; });
  mutate(input => { input.snapshot.fileSha256 = input.snapshot.digest; });
  mutate(input => { input.recordDigest = recordHash(input.record.data); });
  mutate(input => { input.recordDigest = input.payload.byteDigest; });
  mutate(input => { input.intakes[0]!.byteDigest = input.recordDigest; });
  mutate(input => { input.payload.byteDigest = input.recordDigest; });
  mutate(input => { Object.assign(input, { normalizationRule: 'invented-registration' }); });
  const source = { records: Object.fromEntries(inputs.records) };
  const exact = resolveAuditValue({ $audit: 'ref', from: 'source', pointer: `/records/${key}/record` },
    new Map([['source', JSON.parse(JSON.stringify(source)) as RetainedJson]]));
  expect(exact as unknown).toEqual(request.retained.record);
  expect(exact).toHaveProperty('title', request.retained.record.title);
});

test('multipart requests bind ordered actual part identities, framing and assembled byte metadata', async () => {
  const { corpus, inputs } = await importInputs();
  const key = retainedAdmissionCases[2], source = corpus.sources[key]!;
  expect(source.parts.length).toBeGreaterThan(1);
  for (const change of [
    (copy: typeof source) => { copy.retainedRequest!.retained.intakes.reverse(); },
    (copy: typeof source) => { copy.retainedRequest!.retained.intakes[0]!.record = copy.retainedRequest!.retained.intakes[1]!.record; },
    (copy: typeof source) => { copy.retainedRequest!.retained.payload.byteLength--; },
    (copy: typeof source) => { copy.parts.reverse(); },
    (copy: typeof source) => { copy.parts[0]!.rawDigest = copy.retainedRequest!.retained.recordDigest; },
    (copy: typeof source) => {
      const bytes = Buffer.from(canonicalJson({ format: 'rezics-dataset-record-v1', record: copy.retainedRequest!.retained.record }));
      copy.parts = [{ ...copy.parts[0]!, rawBytesBase64: bytes.toString('base64'), rawDigest: sha256(bytes) }];
    },
  ]) {
    const copy = structuredClone(corpus); change(copy.sources[key]!);
    expect(() => assertAuditManifest('imports', copy, [], inputs)).toThrow();
  }
});

test('unexecuted, refused and unrelated commands cannot supply an intake part receipt', async () => {
  const { corpus, inputs, recorder, retain } = await importInputs();
  const original = recorder.bindings.get('command:intake-0-0')!;
  recorder.bindings.delete('command:intake-0-0');
  await retain('unrelated', '/v1/works', command.body, original);
  await expect(recorder.command(session({ async request() { return { status: 403, answer: original }; } }),
    { ...command, id: 'refused-intake', key: 'unit-refused', path: '/v1/sources/intakes' }, 'import-inputs')).rejects.toThrow('observed 403');
  expect(recorder.bindings.has('command:refused-intake')).toBe(false);
  try { assertAuditManifest('imports', corpus, [], inputs); throw new Error('expected blocked intake'); }
  catch (error) { expect(error).toBeInstanceOf(AuditCorpusBlocked); expect(error).toMatchObject({ owner: 'dataset-importer',
    stage: 'import-intake-receipts', assertionsReached: false }); }
});

test('optional retained bindings must match an observed proposed conversion without replacing legacy receipts', async () => {
  const { corpus, inputs, retain, recorder } = await importInputs();
  const source = corpus.sources[bangumi]!, request = source.retainedRequest!;
  const { record: _record, ...retained } = request.retained;
  const binding: RetainedRecordBinding = { ...retained, profile: 'source-retained-record-binding-v1',
    binding: id(6_000), sourceRecord: id(6_001), conversion: id(6_002), mappingRevision: request.mappingRevision,
    normalizationRevision: 'unit-observed-normalization' };
  source.retainedBinding = binding;
  expect(() => assertAuditManifest('imports', corpus, [], inputs)).toThrow('no matching actual conversion result');
  await retain('retained-result', `/v1/sources/observations/${source.parts[0]!.observation.slice(-36)}/conversions`,
    JSON.parse(JSON.stringify(request)) as RetainedJson, { conversion: { conversion: binding.conversion,
      retainedRecord: JSON.parse(JSON.stringify(binding)) as RetainedJson } });
  expect(() => assertAuditManifest('imports', corpus, [], inputs)).not.toThrow();
  expect(source.conversion).toBe(id(5_000));
  source.retainedBinding = { ...binding, normalizationRevision: 'invented-rule' };
  expect(() => assertAuditManifest('imports', corpus, [], inputs)).toThrow('no matching actual conversion result');
  source.retainedBinding = binding;
  recorder.bindings.delete('command:retained-result');
  expect(() => assertAuditManifest('imports', corpus, [], inputs)).toThrow('no matching actual conversion result');
});

test('optional synopsis support needs both the source control result and its matching private management identity', async () => {
  const { corpus, inputs, retain } = await importInputs();
  const value = { ...corpus, synopsisSupport: { support: id(7_000), supportIdentity: 'unit-private-support-identity' } };
  const source = value.sources[bangumi]!, target = value.targets[bangumi]!.resource;
  expect(() => assertAuditManifest('imports', value, [], inputs)).toThrow('no actual source-origin control result');
  await retain('synopsis-control', `/v1/works/${target.slice(-36)}/fields/synopsis/control`,
    { profile: 'work-editorial-field-control-v1', field: 'synopsis', origin: 'source',
      source: { record: source.record, observation: source.observation, conversion: source.conversion! } }, { support: value.synopsisSupport.support });
  expect(() => assertAuditManifest('imports', value, [], inputs)).toThrow('private management receipt');
  await retain('synopsis-management', `/v1/sources/field-supports/${value.synopsisSupport.support.slice(-36)}`, null,
    { support: value.synopsisSupport.support, supportIdentity: value.synopsisSupport.supportIdentity,
      target, sourceRecord: source.record, conversion: source.conversion! }, 'GET');
  expect(() => assertAuditManifest('imports', value, [], inputs)).not.toThrow();
  expect(() => assertAuditManifest('imports', { ...value, synopsisSupport: { ...value.synopsisSupport,
    supportIdentity: 'unobserved-private-identity' } }, [], inputs)).toThrow('private management receipt');
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
