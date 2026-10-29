import { expect } from 'bun:test';
import { bundledRelease } from '@rezics/definitions/bundled';
import { bootstrapGovernance, PLATFORM_RESOURCE } from '../../src/access/bootstrap-governance.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { actionCatalogue, IDEMPOTENCY_HEADER } from '../../src/http/request.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { routeOf } from '../../src/route/route.ts';
import { nativeFixture, cookies, password } from '../access/native-account-bindings-fixture.ts';
import { openGrowthDatabase } from '../support/growth.ts';
import { registerTestClient, testKernel, testRouteKey } from '../support/test-kernel.ts';

/** One ordinary Auth/Access/Realm world; no semantic projection runner is started. */
export async function realmBoardWorld() {
  const db = await openGrowthDatabase();
  const auth = await nativeFixture(db.pool);
  const kernel = testKernel({
    pool: db.pool,
    auth: { ...auth.host.service.verifier, fetch: (url, init) => auth.host.service.handler(new Request(url, init)) },
    writeRate: createWriteRateLimiter({
      secret: 'realm-board-reference-native-write-rate-secret',
      overrides: JSON.stringify({ 'new-account': { write: { maximum: 100000, seconds: 86400 } } }),
    }),
  });
  const scopes = [...actionCatalogue(kernel).keys()].filter((scope) => scope !== 'media:complete');
  const clientId = 'board_reference_' + crypto.randomUUID();
  await registerTestClient(auth.host.service, { clientId, firstParty: true, scopes });
  async function person() {
    const account = await auth.person('board_' + crypto.randomUUID());
    const signed = await auth.request('/signin', { account_id: account.accountId, password, client_id: clientId, scope: scopes });
    expect(signed.status).toBe(200);
    const token = await auth.request('/token', {}, cookies(signed));
    expect(token.status).toBe(200);
    return { accountId: account.accountId, bearer: ((await token.json()) as { access_token: string }).access_token };
  }
  const owner = await person();
  await bootstrapGovernance(db.pool, owner.accountId);
  await bootstrapRelease(db.pool, bundledRelease);
  async function call(method: string, path: string, body?: unknown, options: { key?: string; bearer?: string; headers?: Record<string, string> } = {}) {
    const response = await kernel.handle(new Request('http://kernel.test' + path, {
      method,
      headers: {
        authorization: 'Bearer ' + (options.bearer ?? owner.bearer),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(method === 'GET' ? {} : { [IDEMPOTENCY_HEADER]: JSON.stringify(options.key ?? crypto.randomUUID()) }),
        ...options.headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
    const text = await response.text();
    return { response, value: text ? JSON.parse(text) as Record<string, any> : {} };
  }
  async function checked(method: string, path: string, body: unknown, status = 201, options = {}) {
    const result = await call(method, path, body, options);
    expect({ status: result.response.status, ...(result.response.status === status ? {} : { path, value: result.value }) }).toEqual({ status });
    return result.value;
  }
  for (const action of ['subject:create', 'space:create', 'realm:create', 'context:adopt', 'statement:accept', 'statement:propose', 'moderation:hide']) {
    await checked('POST', '/v1/grants', { resource: PLATFORM_RESOURCE, subject: { kind: 'account', id: owner.accountId }, actions: [action], valid: '(,)' });
  }
  async function subject(type: string, scheme?: string) {
    const result = await checked('POST', '/v1/subjects', {
      type, labels: { en: 'Fixed native board reference' },
      ...(scheme ? { statements: { 'skos:inScheme': [{ property: { id: 'skos:inScheme' }, value: { type: 'value', content: scheme } }] } } : {}),
    });
    return result.subject.id as string;
  }
  const schemeId = await subject('skos:ConceptScheme');
  const conceptId = await subject('skos:Concept', schemeId);
  const space = (await checked('POST', '/v1/spaces', { title: 'Native board host', summary: 'Native board host' })).space;
  const realm = (await checked('POST', '/v1/realms', { spaceId: space.spaceId, title: 'Native board Realm', summary: 'Native board Realm', visibility: 'public', contextId: GLOBAL_CONTEXT })).realm;
  const scheme = await checked('PUT', `/v1/realms/${realm.realmId}/boardScheme`, { schemeId }, 200, { headers: { 'if-match': JSON.stringify(realm.headRevisionId) } });
  realm.headRevisionId = scheme.realm.headRevisionId;
  async function board(id = conceptId, key = crypto.randomUUID()) {
    return call('POST', `/v1/realms/${realm.realmId}/boards`, { conceptId: id, title: 'Native Concept board', visibility: 'published' }, { key });
  }
  async function effects() {
    return (await db.admin.query(`SELECT
      (SELECT count(*) FROM content.board) AS boards,
      (SELECT count(*) FROM access.resource_initialization) AS initialized,
      (SELECT count(*) FROM access.resource_role_grant) AS roles,
      (SELECT count(*) FROM access.resource_grant) AS grants,
      (SELECT count(*) FROM core.receipt) AS receipts,
      (SELECT count(*) FROM core.outbox) AS outbox`)).rows[0];
  }
  async function lag() {
    return (await db.admin.query(`SELECT p.position::text, c.position::text AS checkpoint,
      (SELECT count(*) FROM semantic.outbound_link WHERE route=$1 AND subject_id=$2) AS links
      FROM core.partition p LEFT JOIN core.consumer_checkpoint c ON c.partition_no=p.partition_no AND c.consumer='semantic_links'
      WHERE p.partition_no=$3`, [routeOf(conceptId), conceptId, Math.floor(routeOf(conceptId)! / 16)])).rows[0];
  }
  return { db, auth, kernel, owner, realm, schemeId, conceptId, call, checked, subject, board, effects, lag, routeKey: testRouteKey(),
    async close() { await auth.stop(); await auth.authPool.end(); await auth.close(); await db.close(); },
  };
}
