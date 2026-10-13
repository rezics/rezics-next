import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildMainOpenApi } from '../api/generate.ts';
import { unreviewedActingReads, webActingIdentityViolations, type ActingReadReview, type ReadContract } from './web-acting-identity.ts';

const root = resolve(import.meta.dir, '../..');
const contract: ReadContract = { paths: {
  '/v1/realms/{realm}/decisions': { get: { parameters: [{ in: 'query', name: 'actingSubject' }] } },
  '/v1/realms/{realm}/modules/recent-decisions': { get: {} },
  '/v1/me/person-preferences': { get: { parameters: [{ in: 'query', name: 'actingSubject', required: true }] } },
  '/v1/resources/summaries': { post: { requestBody: { content: { 'application/json': { schema: {
    properties: { actingSubject: {} },
  } } } } } },
  '/v1/graph/queries': { post: { requestBody: { content: { 'application/json': { schema: {
    properties: { actingSubject: {} }, required: ['actingSubject'],
  } } } } } },
} };

function inspect(source: string) {
  const directory = mkdtempSync(resolve(root, '.temp/web-acting-identity-'));
  const file = `${directory.slice(root.length + 1)}/read.tsx`;
  try {
    mkdirSync(directory, { recursive: true });
    writeFileSync(resolve(root, file), source);
    return webActingIdentityViolations(root, [file], contract);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

test('query comments, unrelated headers and explicit empty identities cannot satisfy the guard', () => {
  expect(inspect(`
    main.v1.me['person-preferences'].get({ query: { label: 'actingSubject' } });
    main.v1.me['person-preferences'].get({ query: { /* actingSubject */ language: 'en' } });
    main.v1.me['person-preferences'].get({ query: {}, headers: { actingSubject: selected } });
    main.v1.me['person-preferences'].get({ query: { actingSubject: undefined } });
  `)).toHaveLength(4);
});

test('inventory reviews cannot bless another read or survive a changed query initializer', () => {
  const directory = mkdtempSync(resolve(root, '.temp/web-acting-identity-'));
  const path = `${directory.slice(root.length + 1)}/read.ts`;
  const source = 'const query = incoming; main.v1.me["person-preferences"].get({ query });';
  try {
    writeFileSync(resolve(root, path), source);
    const violations = webActingIdentityViolations(root, [path], contract);
    const reviews = { [path]: { sha256: createHash('sha256').update(source).digest('hex'),
      reason: 'Fixture forwarding review', reads: violations.map(item => `${item.operation}: ${item.read}`) } };
    expect(unreviewedActingReads(root, violations, reviews)).toEqual([]);
    writeFileSync(resolve(root, path), `// Explain the unchanged identity transport.\n${source}`);
    expect(unreviewedActingReads(root, webActingIdentityViolations(root, [path], contract), reviews)).toEqual([]);
    expect(unreviewedActingReads(root, [{ ...violations[0]!, operation: 'GET /v1/new-read' }], reviews)).toHaveLength(1);
    writeFileSync(resolve(root, path), source.replace('incoming', '{}'));
    expect(unreviewedActingReads(root, webActingIdentityViolations(root, [path], contract), reviews)).toHaveLength(1);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('a dormant adapter cannot acquire a production caller without identity review', () => {
  const directory = mkdtempSync(resolve(root, '.temp/web-acting-identity-'));
  const path = `${directory.slice(root.length + 1)}/read.ts`;
  const caller = `${directory.slice(root.length + 1)}/page.ts`;
  const source = 'export function legacyRead(main) { return main.v1.me["person-preferences"].get(); }';
  try {
    writeFileSync(resolve(root, path), source);
    const violations = webActingIdentityViolations(root, [path], contract);
    const reviews = { [path]: { sha256: createHash('sha256').update(source).digest('hex'),
      reason: 'Fixture dormant export', unusedExport: 'legacyRead',
      reads: violations.map(item => `${item.operation}: ${item.read}`) } };
    expect(unreviewedActingReads(root, violations, reviews, [path])).toEqual([]);
    writeFileSync(resolve(root, caller), 'import { legacyRead as read } from "./read.ts"; read(main);');
    expect(unreviewedActingReads(root, violations, reviews, [path, caller])).toHaveLength(1);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('Eden authenticated reads cannot omit identity, including new callers and client aliases', () => {
  const violations = inspect(`
    const decisions = browserMainApi().v1.realms({ realm }).decisions;
    decisions.get({ query: {} });
    mainApiWithToken(token).v1.realms({ realm }).decisions.get();
    main.v1.me['person-preferences'].get({ query: {} });
  `);
  expect(violations.map(item => item.operation).sort()).toEqual([
    'GET /v1/me/person-preferences', 'GET /v1/realms/{realm}/decisions', 'GET /v1/realms/{realm}/decisions',
  ]);
});

test('raw fetch and server reads are checked against the same contracts', () => {
  expect(inspect(`
    fetch('/api/main/v1/me/person-preferences', { credentials: 'same-origin' });
    serverRead(\`\${origin}/v1/realms/\${realm}/decisions\`, { headers: { authorization: token } });
    fetch('/api/main/v1/realms/example/decisions');
    const read = fetch;
    read('/api/main/v1/me/person-preferences');
  `)).toHaveLength(4);
});

test('body-bearing reads also require identity transport through Eden and raw fetch', () => {
  expect(inspect(`
    main.v1.resources.summaries.post({ resources });
    fetch('/api/main/v1/resources/summaries', { method: 'POST', body: JSON.stringify({ resources }) });
    main.v1.resources.summaries.post({ resources, actingSubject });
    fetch('/api/main/v1/resources/summaries', { method: 'POST', body: JSON.stringify({ resources, actingSubject }) });
    mainApiWithToken(undefined).v1.resources.summaries.post({ resources });
    mainApiWithToken(undefined).v1.graph.queries.post({ query });
    fetch('/api/main/v1/resources/summaries', { method: 'POST', headers: { actingSubject }, body: '{}' });
  `)).toHaveLength(4);
});

test('a shadowed anonymous client cannot exempt an authenticated reader', () => {
  expect(inspect(`
    const main = mainApiWithToken(undefined);
    function read(main: MainClient) { main.v1.realms({ realm }).decisions.get(); }
    function second() {
      const { main } = selectedReader();
      main.v1.realms({ realm }).decisions.get();
    }
    const get = authenticated.v1.me['person-preferences'].get;
    get({ query: {} });
    const mixed = { main: mainApiWithToken(token), anonymous: mainApiWithToken(undefined) };
    mixed.main.v1.realms({ realm }).decisions.get();
  `)).toHaveLength(4);
});

test('selected query identities, explicit anonymous reads and public publications remain valid', () => {
  expect(inspect(`
    const query = { actingSubject: selected };
    main.v1.realms({ realm }).decisions.get({ query });
    browserMainApi().v1.me['person-preferences'].get({ query: { actingSubject } });
    mainApiWithToken(undefined).v1.realms({ realm }).decisions.get({ query: {} });
    browserMainApi(undefined, { anonymous: true }).v1.realms({ realm }).decisions.get();
    main.v1.realms({ realm }).modules['recent-decisions'].get();
    fetch('/api/main/v1/me/person-preferences?actingSubject=' + selected);
    fetch('/api/main/v1/realms/example/decisions', { credentials: 'omit' });
    // main.v1.me['person-preferences'].get();
  `)).toEqual([]);
});

test('production web reads introduce no acting identity omissions against live Main contracts', async () => {
  const files = [...new Bun.Glob('**/*.{ts,tsx}').scanSync({ cwd: resolve(root, 'apps/web') })]
    .filter(path => !/^(?:tests|node_modules|dist|\.vinext|\.temp)\//.test(path)
      && !/\.(?:test|stories|fixture)\./.test(path))
    .map(path => `apps/web/${path}`);
  const api = JSON.parse(await buildMainOpenApi()) as ReadContract;
  const violations = webActingIdentityViolations(root, files, api);
  writeFileSync(resolve(root, '.temp/web-acting-identity-inventory.json'), JSON.stringify(violations, null, 2));
  const reviews = JSON.parse(readFileSync(resolve(import.meta.dir, 'web-acting-identity-reviews.json'), 'utf8')) as Record<string, ActingReadReview>;
  expect(unreviewedActingReads(root, violations, reviews, files)).toEqual([]);
});
