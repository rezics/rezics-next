import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { Elysia } from 'elysia';
import { AccountAssertionVerifier, type VerifiedAccountAssertion } from '../src/modules/account/verify-assertion.ts';
import { decodeReadCursor, encodeReadCursor, WorkReadExpired, type ReadRow } from '../src/modules/work/read-session.ts';
import { RV } from '../src/modules/work/activate.ts';
import { readingPositionsRoutes } from '../src/routes/reading-positions.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';

const id = () => `https://rezics.com/id/${randomUUID()}`;
const term = (value: string) => ({ type: 'literal' as const, value });
type Page = { items: { occurrence: string }[]; nextCursor: string | null; sourcePosition: { dataEpoch: string; sequence: string } };

async function fixture() {
  const work = id(), structure = id(), revision = id(), actor = id();
  const occurrences = [id(), id(), id()];
  const issuer = 'https://account.renewal.test', audience = 'rezics-main';
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...await exportJWK(publicKey), kid: 'renewal', alg: 'RS256', use: 'sig' };
  let active = true, principalActive = true, visible = true, scope = 'work:read', emailVerified = true;
  let sequence = '1', generation = '1', introspections = 0;
  let contentEvidence = { age: 'adult', country: 'US', accountEligible: true, adultAvailable: true,
    categories: { general: true, r15: true, r18: true, r18g: true } };
  const issued = new Map<string, Record<string, unknown>>();
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    if (new URL(request.url).pathname === '/jwks') return Response.json({ keys: [jwk] });
    const body = new URLSearchParams(await request.text());
    if (body.get('client_id') !== 'main-resource' || body.get('client_secret') !== 'test-secret')
      return new Response('unauthorized', { status: 401 });
    introspections++;
    const claims = issued.get(body.get('token') ?? '');
    return Response.json({ ...claims, active: active && !!claims, scope, email_verified: emailVerified,
      client_id: claims?.client_id, rezics_content_evidence: contentEvidence });
  } });
  const base = `http://127.0.0.1:${server.port}`;
  const account = new AccountAssertionVerifier({ issuer, audience, jwksUrl: `${base}/jwks`,
    introspectUrl: `${base}/introspect`, clientId: 'main-resource', clientSecret: 'test-secret' });
  const now = Math.floor(Date.now() / 1000);
  const token = async (changes: Record<string, unknown> = {}) => {
    const claims = { iss: issuer, sub: 'reader', aud: audience, iat: now - 2, exp: now + 298,
      client_id: 'reader-client', rezics_auth_mode: 'person', rezics_consent_id: 'consent',
      rezics_consent_generation: '1', ...changes };
    const signed = await new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'renewal' }).sign(privateKey);
    issued.set(signed, claims); return signed;
  };
  const rows = occurrences.map((occurrence, index): ReadRow => ({
    work: term(work), structure: term(structure), revision: term(revision), generation: term(structure),
    placement: term(id()), occurrence: term(occurrence), parent: term(structure), segmentKey: term('a'),
    orderKey: term(String(index)), role: term(`${RV}ChapterRole`), matches: term('true'),
  }));
  const query = async (sparql: string) => {
    const control = { epoch: term('epoch'), sequence: term(sequence) };
    let bindings: ReadRow[];
    if (sparql.includes('SELECT ?epoch ?sequence ?hold ?r')) {
      bindings = [control, ...(visible ? [{ ...control, r: term(work), work: term(work), type: term('work'),
        public: term('true'), label: { ...term('Story'), 'xml:lang': 'en' } }] : [])];
    } else if (sparql.includes('# reading-position:work\n')) {
      bindings = [{ work: term(work), structure: term(structure), revision: term(revision), generation: term(structure) }];
    } else if (sparql.includes('# reading-position:records')) {
      const values = sparql.match(/VALUES \?occurrence \{([^}]+)}/)?.[1] ?? '';
      bindings = rows.filter(row => values.includes(row.occurrence!.value));
    } else if (sparql.includes('# reading-position:range')) {
      const after = sparql.match(/&& \?orderKey > "(\d+)"/)?.[1];
      bindings = rows.filter(row => after === undefined || Number(row.orderKey!.value) > Number(after));
    } else if (sparql.includes('# reading-position:ordinals')) {
      bindings = rows.filter(row => sparql.includes(`<${row.occurrence!.value}>`))
        .map(row => ({ occurrence: row.occurrence!, ordinal: term(String(Number(row.orderKey!.value) + 1)) }));
    } else bindings = [control];
    return { results: { bindings } };
  };
  const deps = { account, environment: { lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' }, fuseki: { query } },
    access: { assertRecoveryOpen: async () => {}, activePrincipalId: async () => principalActive ? 'reader' : null },
    readingPositions: { generation: async () => generation },
  } as unknown as MainWorkDependencies;
  const app = new Elysia().use(readingPositionsRoutes(deps));
  const read = (signed: string, params: Record<string, string> = {}) => app.handle(new Request(
    `http://localhost/v1/reading-positions/${work.slice(-36)}?${new URLSearchParams({ actingSubject: actor,
      position: 'start', limit: '2', ...params })}`, { headers: { authorization: `Bearer ${signed}` } }));
  return { work, actor, occurrences, account, token, read, introspections: () => introspections,
    revoke: () => { active = false; }, deactivate: () => { principalActive = false; },
    hide: () => { visible = false; }, move: () => { sequence = '2'; },
    revelations: () => { generation = '2'; }, scope: (value: string) => { scope = value; },
    unverify: () => { emailVerified = false; },
    restrictContent: () => { contentEvidence = { ...contentEvidence, adultAvailable: false }; },
    close: () => server.stop(true) };
}

test('reading-position continuation survives verified assertion expiry renewal', async () => {
  const f = await fixture();
  try {
    const original = await f.token();
    const renewed = await f.token({ iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300 });
    const verify = (signed: string) => f.account.verify(new Request('http://localhost', {
      headers: { authorization: `Bearer ${signed}` } }), ['work:read']);
    const before = await verify(original), after = await verify(renewed);
    expect(after.accountExpiresAt!).toBeGreaterThan(before.accountExpiresAt!);
    const identity = ({ accountExpiresAt: _expiry, currentAssertion: _verify, ...principal }: VerifiedAccountAssertion) => principal;
    expect(identity(after)).toEqual(identity(before));
    const firstResponse = await f.read(original);
    expect(firstResponse.status).toBe(200);
    const first = await firstResponse.json() as Page;
    expect(first.items.map(item => item.occurrence)).toEqual(f.occurrences.slice(0, 2));
    expect(first.nextCursor).toBeString();
    const response = await f.read(renewed, { cursor: first.nextCursor! });
    const second = await response.json() as Page;
    await Bun.write(`.temp/goal/evidence/reading-position-owner-${Bun.env.REZICS_QA_RUN_ID}.json`, JSON.stringify({
      sourceRun: Bun.env.REZICS_QA_RUN_ID, before: identity(before), beforeExpiry: before.accountExpiresAt,
      after: identity(after), afterExpiry: after.accountExpiresAt, first, replay: { status: response.status, body: second },
      introspections: f.introspections(),
    }, null, 2));
    expect(response.status).toBe(200);
    expect(second.items.map(item => item.occurrence)).toEqual(f.occurrences.slice(2));
    expect(second.nextCursor).toBeNull();
    expect(second.sourcePosition).toEqual(first.sourcePosition);
    expect(f.introspections()).toBe(4);
  } finally { await f.close(); }
});

test('reading-position renewal retains current identity, consent, scope, disclosure and basis fences', async () => {
  const f = await fixture();
  try {
    const signed = await f.token();
    const first = await (await f.read(signed)).json() as Page;
    expect(first.nextCursor).toBeString();
    const params = { cursor: first.nextCursor! };
    const deny = async (token: string, status: number, code: string, changes: Record<string, string> = {}) => {
      const calls = f.introspections();
      const response = await f.read(token, { ...params, ...changes });
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ code });
      expect(f.introspections()).toBe(calls + (status === 401 && token !== signed ? 0 : 1));
    };
    for (const changes of [{ sub: 'other-reader' }, { client_id: 'other-client' },
      { rezics_auth_mode: 'workload' }, { rezics_consent_id: 'other-consent' },
      { rezics_consent_generation: '2' }, { aud: ['rezics-main', 'other-service'] }]) {
      await deny(await f.token(changes), 400, 'invalid_work_read');
    }
    await deny(signed, 400, 'invalid_work_read', { actingSubject: id() });
    await deny(signed, 400, 'invalid_work_read', { position: 'all' });
    await deny(signed, 400, 'invalid_work_read', { q: 'Chapter' });
    f.unverify(); await deny(signed, 400, 'invalid_work_read');
    f.restrictContent(); await deny(signed, 400, 'invalid_work_read');
    f.scope('work:read profile:read'); await deny(signed, 400, 'invalid_work_read');
    f.scope('profile:read'); await deny(signed, 401, 'account_assertion_denied');
    f.scope('work:read');
    await deny(await f.token({ iss: 'https://other.invalid' }), 401, 'account_assertion_denied');
    await deny(await f.token({ aud: 'other-service' }), 401, 'account_assertion_denied');
    await deny(await f.token({ iat: 1, exp: 2 }), 401, 'account_assertion_denied');
    f.revoke(); await deny(signed, 401, 'account_assertion_denied');
  } finally { await f.close(); }
  for (const change of ['deactivate', 'hide', 'move', 'revelations'] as const) {
    const f = await fixture();
    try {
      const signed = await f.token();
      const first = await (await f.read(signed)).json() as Page;
      f[change]();
      const response = await f.read(signed, { cursor: first.nextCursor! });
      expect(response.status).toBe(change === 'deactivate' ? 401 : change === 'hide' ? 404
        : change === 'revelations' ? 400 : 409);
    } finally { await f.close(); }
  }
}, 30_000);

test('reading-position cursors retain their explicit expiry fence', () => {
  const binding = ['reading-position-chooser-v2', id(), { issuer: 'https://account.renewal.test', subject: 'reader' }];
  const position = { dataEpoch: 'epoch', sequence: '1' };
  const expired = encodeReadCursor(binding, position, id(), '', Date.now() - 1);
  expect(() => decodeReadCursor(expired, binding, position)).toThrow(WorkReadExpired);
});
