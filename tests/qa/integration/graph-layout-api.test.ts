import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Pool } from 'pg';
import { ContentCore } from '../../../services/content/src/core.ts';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { createMainApp, type MainWorkDependencies } from '../../../services/main/src/app.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry } from '../../../services/main/src/modules/access/admission.ts';
import { GRAPH_LAYOUT_ACTION, GRAPH_LAYOUT_SCOPE, GraphLayouts }
  from '../../../services/main/src/modules/graph-layout/store.ts';
import type { GraphLayoutDependencies } from '../../../services/main/src/routes/graph-layouts.ts';
import { grantAgent, meteredPool, nativeId, requireQa, startAccount }
  from './recommendation-support.ts';
import { cloneQaOwnerDatabases } from '../support/databases.ts';

const root = resolve(import.meta.dir, '../../..');
const state = join(root, '.temp', `graph-layout-api-${randomUUID()}`);
let owners: Awaited<ReturnType<typeof cloneQaOwnerDatabases>>;
let account: Awaited<ReturnType<typeof startAccount>>;
let access: Pool;
let contentPool: Pool;
let app: ReturnType<typeof createMainApp>;
let actor: Awaited<ReturnType<typeof grantAgent>>;
let outsider: Awaited<ReturnType<typeof grantAgent>>;
let writeToken = '';
let readToken = '';
let outsiderToken = '';
let fuseki: FusekiClient;

beforeAll(async () => {
  owners = await cloneQaOwnerDatabases(requireQa(), ['access', 'content'], 'privileged');
  access = new Pool({ connectionString: owners.urls.access });
  contentPool = new Pool({ connectionString: owners.urls.content });
  await migrateContent(contentPool);
  const content = new ContentCore(contentPool);
  account = await startAccount('work:edit work:read');
  const writer = await account.signUp('layout-writer');
  const stranger = await account.signUp('layout-stranger');
  actor = await grantAgent(access, account.issuer, writer, GRAPH_LAYOUT_SCOPE, GRAPH_LAYOUT_ACTION);
  outsider = await grantAgent(access, account.issuer, stranger, 'graph-layout:other', GRAPH_LAYOUT_ACTION);
  [writeToken, readToken, outsiderToken] = await Promise.all([
    account.tokenFor(writer, 'openid work:edit'),
    account.tokenFor(writer, 'openid work:read'),
    account.tokenFor(stranger, 'openid work:edit work:read'),
  ]);
  fuseki = new FusekiClient(Bun.env.FUSEKI_URL!);
  const dependencies: MainWorkDependencies & GraphLayoutDependencies = {
    environment: { fuseki, lineage: { dataEpoch: Bun.env.MAIN_DATA_EPOCH!, routingEpoch: Bun.env.MAIN_ROUTING_EPOCH! },
      objectDirectory: join(state, 'objects') },
    account: account.verifier, access: new AccessAdmissionRegistry(access),
    graphLayouts: new GraphLayouts(access, contentPool, content),
  };
  app = createMainApp(fuseki, dependencies);
}, 120_000);

afterAll(async () => {
  await account?.close();
  await Promise.all([access?.end(), contentPool?.end()]);
  await owners?.close();
  rmSync(state, { recursive: true, force: true });
}, 60_000);

async function call(path: string, token: string, body?: object, key = `layout-${randomUUID()}`) {
  const response = await app.handle(new Request(`http://main.local${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${token}`,
      ...(body ? { 'content-type': 'application/json', 'idempotency-key': key } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }));
  return { status: response.status, body: await response.json() as Record<string, unknown> & {
    layout?: string; revision?: string; predecessor?: string | null; code?: string; replayed?: boolean } };
}

test('GRAPH06: moving a saved display group revises Content view state without graph effects', async () => {
  const anchor = nativeId();
  const appearance = nativeId();
  const view = { profile: 'https://rezics.com/definition/relationship-view-v1', anchor, context: null };
  const body = { view, nodes: [{ resource: appearance, x: 10, y: 20, group: 'appearance', pinned: true }],
    groups: [{ id: 'appearance', label: 'Appearance', x: 0, y: 0, collapsed: false }] };
  const graphSnapshot = 'SELECT ?g ?s ?p ?o WHERE { GRAPH ?g { ?s ?p ?o } } ORDER BY ?g ?s ?p ?o';
  const baseline = await fuseki.query(graphSnapshot);
  const create = { profile: 'graph-layout-change-v1', actingSubject: actor.agent,
    layout: null, expectedHead: null, body };
  const first = await call('/v1/graph-layouts', writeToken, create, 'create-layout');
  expect(first.status).toBe(200);
  expect(first.body).toMatchObject({ predecessor: null, replayed: false });
  expect(await call('/v1/graph-layouts', writeToken, create, 'create-layout'))
    .toMatchObject({ status: 200, body: { layout: first.body.layout, revision: first.body.revision,
      replayed: true } });
  const moved = { ...body, nodes: [{ ...body.nodes[0]!, x: 150 }],
    groups: [{ ...body.groups[0]!, x: 100, collapsed: true }] };
  const revise = { ...create, layout: first.body.layout, expectedHead: first.body.revision, body: moved };
  const second = await call('/v1/graph-layouts', writeToken, revise, 'move-appearance');
  expect(second).toMatchObject({ status: 200, body: { layout: first.body.layout,
    predecessor: first.body.revision, body: moved } });
  const layoutId = first.body.layout!.slice(-36);
  const read = await call(`/v1/graph-layouts/${layoutId}?actingSubject=${encodeURIComponent(actor.agent)}`,
    readToken);
  expect(read).toMatchObject({ status: 200, body: { revision: second.body.revision, body: moved } });
  const history = await call(`/v1/graph-layouts/${layoutId}?actingSubject=${encodeURIComponent(actor.agent)}&revision=${first.body.revision}`,
    readToken);
  expect(history).toMatchObject({ status: 200, body: { revision: first.body.revision, body } });
  expect(await call('/v1/graph-layouts', writeToken, revise, 'move-appearance'))
    .toMatchObject({ status: 200, body: { revision: second.body.revision, replayed: true } });
  expect(await call('/v1/graph-layouts', writeToken,
    { ...revise, body: { ...moved, groups: [{ ...moved.groups[0]!, x: 101 }] } }, 'move-appearance'))
    .toMatchObject({ status: 409, body: { code: 'idempotency_conflict' } });
  expect(await call('/v1/graph-layouts', writeToken, { ...revise, body }, 'stale-layout'))
    .toMatchObject({ status: 409, body: { code: 'stale_head' } });
  expect(await call('/v1/graph-layouts', writeToken,
    { ...revise, expectedHead: second.body.revision,
      body: { ...moved, view: { ...view, context: nativeId() } } }, 'context-reinterpretation'))
    .toMatchObject({ status: 409, body: { code: 'idempotency_conflict' } });
  expect(await call('/v1/graph-layouts', outsiderToken,
    { ...create, actingSubject: outsider.agent }, 'denied-layout'))
    .toMatchObject({ status: 403, body: { code: 'graph_layout_denied' } });
  expect((await call(`/v1/graph-layouts/${layoutId}?actingSubject=${encodeURIComponent(outsider.agent)}`,
    outsiderToken)).status).toBe(403);
  const after = await fuseki.query(graphSnapshot);
  expect(after).toEqual(baseline);
  expect((await contentPool.query('SELECT count(*)::int AS n FROM content.graph_layout WHERE id = $1',
    [first.body.layout])).rows[0].n).toBe(1);
}, 120_000);

test('GRAPH06: saving 1 or 200 positions uses a fixed number of owner statements', async () => {
  const accessMeter = meteredPool(access);
  const contentMeter = meteredPool(contentPool);
  const store = new GraphLayouts(accessMeter.pool, contentMeter.pool, new ContentCore(contentMeter.pool));
  const principal = await account.verifier.verify(new Request('http://main.local/v1/graph-layouts', {
    headers: { authorization: `Bearer ${writeToken}` },
  }), ['work:edit']);
  const costs = [];
  for (const size of [1, 200]) {
    const body = { view: { profile: 'https://rezics.com/definition/relationship-view-v1',
      anchor: nativeId(), context: null },
    nodes: Array.from({ length: size }, (_, index) => ({ resource: nativeId(), x: index, y: index,
      pinned: false })), groups: [] };
    accessMeter.reset();
    contentMeter.reset();
    const saved = await store.save({ principal, actingSubject: actor.agent }, null, null, body,
      { idempotencyKey: `cost-${size}-${randomUUID()}`, requestDigest: '0'.repeat(64) });
    expect(saved.body.nodes).toHaveLength(size);
    costs.push({ access: accessMeter.count(), content: contentMeter.count() });
  }
  expect(costs[0]).toEqual(costs[1]);
}, 120_000);
