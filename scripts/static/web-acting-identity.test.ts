import { repositoryGlob } from '../lib/repository-files.ts';
import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildMainOpenApi } from '../api/generate.ts';
import { unresolvedActingReads, webActingIdentityViolations, type ActingReadDebt, type ReadContract } from './web-acting-identity.ts';

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
    main. /* client */ v1.me['person-preferences']. /* read */ get({ query: {} });
  `)).toHaveLength(5);
});

test('named debt ignores comments and correct new reads but cannot bless another read or changed input', () => {
  const directory = mkdtempSync(resolve(root, '.temp/web-acting-identity-'));
  const path = `${directory.slice(root.length + 1)}/read.ts`;
  const source = 'const query = incoming; main.v1.me["person-preferences"].get({ query });';
  try {
    writeFileSync(resolve(root, path), source);
    const violations = webActingIdentityViolations(root, [path], contract);
    const debt = violations.map(item => ({ ...item, id: 'unknown-input-forwarding', reason: 'Analyzer cannot trace incoming.' }));
    expect(unresolvedActingReads(root, violations, debt)).toEqual([]);
    writeFileSync(resolve(root, path), `// Explain the unchanged identity transport.\n${source}`);
    expect(unresolvedActingReads(root, webActingIdentityViolations(root, [path], contract), debt)).toEqual([]);
    writeFileSync(resolve(root, path), source.replace('{ query }', '{ /* unchanged */ query }') + `
      main.v1.me['person-preferences'].get({ query: { actingSubject: selected } });
      mainApiWithToken(undefined).v1.realms({ realm }).decisions.get();
    `);
    expect(unresolvedActingReads(root, webActingIdentityViolations(root, [path], contract), debt)).toEqual([]);
    expect(unresolvedActingReads(root, [{ ...violations[0]!, operation: 'GET /v1/new-read' }], debt)).toHaveLength(1);
    expect(unresolvedActingReads(root, [...violations, ...violations], debt)).toHaveLength(1);
    writeFileSync(resolve(root, path), source.replace('incoming', '{}'));
    expect(unresolvedActingReads(root, webActingIdentityViolations(root, [path], contract), debt)).toHaveLength(1);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('dormant debt expires when an adapter acquires a production caller', () => {
  const directory = mkdtempSync(resolve(root, '.temp/web-acting-identity-'));
  const path = `${directory.slice(root.length + 1)}/read.ts`;
  const caller = `${directory.slice(root.length + 1)}/page.ts`;
  const source = 'export function legacyRead(main) { return main.v1.me["person-preferences"].get(); }';
  try {
    writeFileSync(resolve(root, path), source);
    const violations = webActingIdentityViolations(root, [path], contract);
    const debt = violations.map(item => ({ ...item, id: 'dormant-helper', reason: 'No production caller.', unusedExport: 'legacyRead' }));
    expect(unresolvedActingReads(root, violations, debt, [path])).toEqual([]);
    writeFileSync(resolve(root, caller), 'import { legacyRead as read } from "./read.ts"; read(main);');
    expect(unresolvedActingReads(root, violations, debt, [path, caller])).toHaveLength(1);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('whole typed identity parameters are forwarded without a debt entry', () => {
  expect(inspect(`
    function page(query: { actingSubject?: string; cursor?: string }) {
      main.v1.realms({ realm }).decisions.get({ query });
      main.v1.realms({ realm }).decisions.get({ query: { ...query, limit: 10 } });
    }
    const read = (body: { resources: string[]; actingSubject: string }) =>
      main.v1.resources.summaries.post(body);
    function rest(input: { work: string; actingSubject?: string }) {
      const { work, ...query } = input;
      main.v1.realms({ realm }).decisions.get({ query: { ...query } });
    }
    function commented(/* chosen input */ input: /* identity shape */ { actingSubject?: string }) {
      const query /* preserve input */ = /* forward */ input;
      main.v1.realms({ realm }).decisions.get({ query /* transport */: query });
      main. /* client */ v1.realms({ realm }).decisions. /* read */ get({ query });
      const anonymous /* public client */ = mainApiWithToken(/* no token */ undefined);
      anonymous.v1.realms({ realm }).decisions.get();
    }
  `)).toEqual([]);
  expect(inspect(`
    function page(query: { actingSubject: string }) {
      function nested(query: { cursor?: string }) {
        main.v1.realms({ realm }).decisions.get({ query });
      }
      function reconstructed() {
        main.v1.realms({ realm }).decisions.get({ query: { cursor: query.cursor } });
      }
      function shadowed() {
        const query = {};
        main.v1.realms({ realm }).decisions.get({ query });
      }
      main.v1.realms({ realm }).decisions.get({ query: { ...query, actingSubject: undefined } });
      const callback = query => main.v1.realms({ realm }).decisions.get({ query });
      const { actingSubject, ...rest } = query;
      main.v1.realms({ realm }).decisions.get({ query: { ...rest } });
    }
    function nestedField(query: { metadata: { actingSubject: string }; label: 'actingSubject:string' }) {
      main.v1.realms({ realm }).decisions.get({ query });
    }
    function property(input: { actingSubject: string; query: { cursor: string } }) {
      const { query } = input;
      main.v1.realms({ realm }).decisions.get({ query });
    }
  `)).toHaveLength(8);
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

const anonymousType = `import type { AnonymousMainClient } from '../../apps/web/features/api/main.ts';`;
test('the adapter brand carries anonymous authority through required and optional supplied parameters', () => {
  expect(inspect(`${anonymousType}
    function page(anonymous: AnonymousMainClient) {
      anonymous.v1.realms({ realm }).decisions.get();
      anonymous.v1.resources.summaries.post({ resources });
      const forwarded = anonymous;
      forwarded.v1.resources.summaries.post({ resources });
    }
    const optional = (anonymous?: AnonymousMainClient) => {
      if (anonymous) return anonymous.v1.resources.summaries.post({ resources });
    };
  `)).toEqual([]);
  expect(inspect(`
    import type { AnonymousMainClient as PublicClient } from '../../apps/web/features/api/main.ts';
    function page(main: PublicClient) { return main.v1.resources.summaries.post({ resources }); }
  `)).toEqual([]);
});

test('plain and persona clients cannot inherit the supplied anonymous parameter exemption', () => {
  expect(inspect(`${anonymousType}
    function plain(anonymous: MainClient) { anonymous.v1.resources.summaries.post({ resources }); }
    function persona(main: MainClient, actingSubject: string) { main.v1.resources.summaries.post({ resources }); }
    function mixed(anonymous: AnonymousMainClient | MainClient) { anonymous.v1.resources.summaries.post({ resources }); }
    function outer(anonymous: AnonymousMainClient) {
      function nested(anonymous: MainClient) { anonymous.v1.resources.summaries.post({ resources }); }
      const persona = browserMainApi();
      persona.v1.resources.summaries.post({ resources });
    }
  `)).toHaveLength(5);
});

test('a lookalike or shadowed type and a cast cannot manufacture the adapter brand', () => {
  expect(inspect(`
    type AnonymousMainClient = MainClient;
    function page(anonymous: AnonymousMainClient) { anonymous.v1.resources.summaries.post({ resources }); }
  `)).toHaveLength(1);
  expect(inspect(`
    import type { AnonymousMainClient } from './unrelated.ts';
    function page(anonymous: AnonymousMainClient) { anonymous.v1.resources.summaries.post({ resources }); }
  `)).toHaveLength(1);
  expect(inspect(`${anonymousType}
    function page<AnonymousMainClient>(anonymous: AnonymousMainClient) {
      anonymous.v1.resources.summaries.post({ resources });
    }
  `)).toHaveLength(1);
  expect(inspect(`${anonymousType}
    const anonymous = persona as AnonymousMainClient;
    anonymous.v1.resources.summaries.post({ resources });
  `)).toHaveLength(1);
});

test('the anonymous brand does not bypass an operation with mandatory actingSubject', () => {
  expect(inspect(`${anonymousType}
    function page(anonymous: AnonymousMainClient) { anonymous.v1.graph.queries.post({ query }); }
  `)).toHaveLength(1);
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
  const files = [...repositoryGlob(root, 'apps/web/**/*.{ts,tsx}').map(file => file.slice('apps/web/'.length))]
    .filter(path => !/^(?:tests|node_modules|dist|\.vinext|\.temp)\//.test(path)
      && !/\.(?:test|stories|fixture)\./.test(path))
    .map(path => `apps/web/${path}`);
  const api = JSON.parse(await buildMainOpenApi()) as ReadContract;
  const violations = webActingIdentityViolations(root, files, api);
  writeFileSync(resolve(root, '.temp/web-acting-identity-inventory.json'), JSON.stringify(violations, null, 2));
  const debt = JSON.parse(readFileSync(resolve(import.meta.dir, 'web-acting-identity-debt.json'), 'utf8')) as ActingReadDebt[];
  expect(unresolvedActingReads(root, violations, debt, files)).toEqual([]);
}, 120_000);
