import { expect } from 'bun:test';
import { bundledRelease } from '@rezics/definitions/bundled';
import { bootstrapGovernance, PLATFORM_RESOURCE } from '../../src/access/bootstrap-governance.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { actionCatalogue, IDEMPOTENCY_HEADER } from '../../src/http/request.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { createBoard } from '../../src/content/board-create.ts';
import { createRealmParticipationCheck } from '../../src/community/participation.ts';
import { routeOf } from '../../src/route/route.ts';
import { nativeFixture, cookies, password } from '../access/native-account-bindings-fixture.ts';
import { openGrowthDatabase } from '../support/growth.ts';
import { registerTestClient, testKernel, testRouteKey } from '../support/test-kernel.ts';

/** One ordinary Auth/Access/Realm world; no semantic projection runner is started. */
export async function realmBoardWorld() {
  const db = await openGrowthDatabase();
  db.pool.options.max = 1;
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
    const name = 'board_' + crypto.randomUUID();
    const account = await auth.person(name);
    const signed = await auth.request('/signin', {
      email: `${name}@ordinary.test`,
      password,
      client_id: clientId,
      scope: scopes,
    });
    expect(signed.status).toBe(200);
    const token = await auth.request('/token', {}, cookies(signed));
    expect(token.status).toBe(200);
    return { accountId: account.accountId, bearer: ((await token.json()) as { access_token: string }).access_token };
  }
  const owner = await person();
  await bootstrapGovernance(db.pool, owner.accountId);
  await bootstrapRelease(db.pool, bundledRelease);
  async function call(
    method: string,
    path: string,
    body?: unknown,
    options: { key?: string; bearer?: string; headers?: Record<string, string> } = {},
  ) {
    const response = await kernel.handle(
      new Request('http://kernel.test' + path, {
        method,
        headers: {
          authorization: 'Bearer ' + (options.bearer ?? owner.bearer),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(method === 'GET' ? {} : { [IDEMPOTENCY_HEADER]: JSON.stringify(options.key ?? crypto.randomUUID()) }),
          ...options.headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    const text = await response.text();
    return { response, value: text ? (JSON.parse(text) as Record<string, any>) : {} };
  }
  async function checked(method: string, path: string, body: unknown, status = 201, options = {}) {
    const result = await call(method, path, body, options);
    expect({
      status: result.response.status,
      ...(result.response.status === status ? {} : { path, value: result.value }),
    }).toEqual({ status });
    return result.value;
  }
  for (const action of [
    'subject:create',
    'space:create',
    'realm:create',
    'context:adopt',
    'context:accept',
    'statement:propose',
    'moderation:hide',
    'subject:batch_write',
    'source_fence:takedown',
    'subject:merge',
    'gate:subject_identity',
  ]) {
    await checked('POST', '/v1/grants', {
      resource: PLATFORM_RESOURCE,
      subject: { kind: 'account', id: owner.accountId },
      actions: [action],
      valid: '(,)',
    });
  }
  async function subject(type: string, scheme?: string) {
    const result = await checked('POST', '/v1/subjects', {
      type,
      labels: { en: 'Fixed native board reference' },
      ...(scheme
        ? {
            statements: {
              'skos:inScheme': [{ property: { id: 'skos:inScheme' }, value: { type: 'value', content: scheme } }],
            },
          }
        : {}),
    });
    return result.subject.id as string;
  }
  const schemeId = await subject('skos:ConceptScheme');
  const conceptId = await subject('skos:Concept', schemeId);
  const space = (await checked('POST', '/v1/spaces', { title: 'Native board host', summary: 'Native board host' }))
    .space;
  const realm = (
    await checked('POST', '/v1/realms', {
      spaceId: space.spaceId,
      title: 'Native board Realm',
      summary: 'Native board Realm',
      visibility: 'public',
      contextId: GLOBAL_CONTEXT,
    })
  ).realm;
  const scheme = await checked('PUT', `/v1/realms/${realm.realmId}/boardScheme`, { schemeId }, 200, {
    headers: { 'if-match': JSON.stringify(realm.headRevisionId) },
  });
  realm.headRevisionId = scheme.realm.headRevisionId;
  db.pool.options.max = 1;
  async function board(id = conceptId, key = crypto.randomUUID(), bearer = owner.bearer) {
    return call(
      'POST',
      `/v1/realms/${realm.realmId}/boards`,
      { conceptId: id, title: 'Native Concept board', visibility: 'published' },
      { key, bearer },
    );
  }
  async function effects() {
    return (
      await db.admin.query(`SELECT
      (SELECT count(*) FROM content.board) AS boards,
      (SELECT count(*) FROM access.resource_initialization) AS initialized,
      (SELECT count(*) FROM access.resource_role_grant) AS roles,
      (SELECT count(*) FROM access.resource_grant) AS grants,
      (SELECT count(*) FROM core.receipt) AS receipts,
      (SELECT count(*) FROM core.outbox) AS outbox,
      (SELECT count(*) FROM editorial.write_basis) AS bases,
      (SELECT coalesce(sum(position),0) FROM core.partition) AS position`)
    ).rows[0];
  }
  async function lag() {
    return (
      await db.admin.query(
        `SELECT p.position::text, c.position::text AS checkpoint,
      (SELECT count(*) FROM semantic.outbound_link WHERE route=$1 AND subject_id=$2) AS links
      FROM core.partition p LEFT JOIN core.consumer_checkpoint c ON c.partition_no=p.partition_no AND c.consumer='semantic_links'
      WHERE p.partition_no=$3`,
        [routeOf(conceptId), conceptId, Math.floor(routeOf(conceptId)! / 16)],
      )
    ).rows[0];
  }
  async function propose(id: string, value: unknown = { type: 'value', content: schemeId }) {
    return (
      await checked('POST', `/v1/subjects/${id}/candidates`, {
        statement: { property: { id: 'skos:inScheme' }, value },
      })
    ).candidate as string;
  }
  async function adopt(id: string, candidate: string, expected_head: number | null = null) {
    await checked(
      'POST',
      `/v1/subjects/${id}/candidates/${candidate}:accept`,
      { context: GLOBAL_CONTEXT, expected_head: null },
      200,
    );
    await checked(
      'POST',
      `/v1/subjects/${id}:adopt`,
      {
        context: GLOBAL_CONTEXT,
        property: 'skos:inScheme',
        mode: 'replace',
        selection: [{ candidate, rank: 'preferred' }],
        expected_head,
      },
      200,
    );
  }
  async function imported(id: string) {
    const source = {
      source: 'openlibrary',
      external_id: crypto.randomUUID(),
      record_revision: 'unversioned',
      digest: 'c'.repeat(64),
      converter_revision: 'openlibrary@1',
      field_group: 'facts',
    };
    const references = [
      {
        parts: [
          { property: { id: 'schema:url' }, value: { type: 'value', content: 'https://openlibrary.org/works/OL1W' } },
        ],
      },
    ];
    const result = await checked(
      'POST',
      '/v1/subjects:batchWrite',
      {
        commands: [
          {
            op: 'propose',
            key: crypto.randomUUID(),
            source,
            subject: id,
            statement: { property: { id: 'skos:inScheme' }, value: { type: 'value', content: schemeId }, references },
          },
        ],
      },
      200,
    );
    expect(result.results[0].status).toBe(201);
    return { candidate: result.results[0].value.candidate as string, source, references };
  }
  async function directBoard(id: string) {
    const deadline = Date.now() + 10_000;
    const access = kernel.testAccess;
    const actor = await access.authenticate(owner.bearer, { pool: db.pool, deadline });
    return createBoard(
      {
        pool: db.pool,
        access,
        routeKey: testRouteKey(),
        realmParticipation: createRealmParticipationCheck({ pool: db.pool, access }),
      },
      actor,
      { realmId: realm.realmId, conceptId: id, title: 'Native Concept board', visibility: 'published' },
      { deadline, idempotencyKey: crypto.randomUUID() },
    );
  }
  return {
    person,
    directBoard,
    db,
    auth,
    kernel,
    owner,
    realm,
    schemeId,
    conceptId,
    call,
    checked,
    subject,
    board,
    effects,
    lag,
    propose,
    adopt,
    imported,
    routeKey: testRouteKey(),
    async close() {
      try {
        await auth.close();
      } finally {
        await db.close();
      }
    },
  };
}
