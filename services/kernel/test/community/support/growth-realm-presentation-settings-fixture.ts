import { expect } from 'bun:test';
import { fromPlainText, serializeDocument } from '@rezics/document';
import { createWriteRateLimiter } from '../../../src/access/write-rate.ts';
import { createKernel } from '../../../src/http/kernel.ts';
import { newId, partitionOf, routeOf } from '../../../src/route/route.ts';
import {
  createReactionRelayBase,
  type CallOptions,
  type NativePerson,
} from '../../content/reaction-relay-convergence-fixture.ts';
import { HIGH_RATE_OVERRIDES } from '../../content/support/disclosure-fixtures.ts';
import {
  assertGrowthAccessPaths,
  checkGrowth,
  openGrowthDatabase,
  seed,
  type Population,
} from '../../support/growth.ts';
import { configureTestReceiptKeys, testReceiptKeys } from '../../support/receipt-keys.ts';

export const scales = [256, 1024, 4096] as const;
export const axes = ['unrelated-realms', 'realm-revisions', 'rules-revisions'] as const;
export type Axis = (typeof axes)[number];
export const empty = { avatarMediaId: null, bannerMediaId: null, rules: null } as const;
type Presentation = {
  avatarMediaId: string | null;
  bannerMediaId: string | null;
  rules: { postId: string; revisionId: string } | null;
};

export function rulesBody(bytes = 65_536) {
  const overhead = Buffer.byteLength(serializeDocument(fromPlainText('x'))) - 1;
  const body = fromPlainText('x'.repeat(bytes - overhead));
  expect(Buffer.byteLength(serializeDocument(body))).toBe(bytes);
  return body;
}

export async function presentationSettingsFixture() {
  const base = await createReactionRelayBase();
  const db = await openGrowthDatabase(base.system.database.pool.options.connectionString!).catch(async (error) => {
    await base.system.close();
    throw error;
  });
  configureTestReceiptKeys(db.pool);
  // The registered HTTP composition, its production Access and every prepared source
  // use the instrumented pool. Setup may use the original native fixture's pool.
  const kernel = createKernel({
    pool: db.pool,
    access: () => base.system.access,
    routeKey: base.system.routeKey,
    tokens: base.system.tokenKeys,
    receiptKeys: testReceiptKeys(),
    writeRate: createWriteRateLimiter({
      secret: crypto.randomUUID() + crypto.randomUUID(),
      overrides: HIGH_RATE_OVERRIDES,
    }),
    ratePeer: () => '127.0.0.1',
  });
  async function call(method: string, path: string, options: CallOptions = {}) {
    const headers = new Headers(options.headers);
    headers.set('authorization', `Bearer ${options.bearer ?? base.author.bearer}`);
    if (method !== 'GET') headers.set('idempotency-key', JSON.stringify(options.key ?? crypto.randomUUID()));
    if (options.body !== undefined) headers.set('content-type', 'application/json');
    const response = await kernel.handle(new Request(`https://content.test${path}`, {
      method, headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }));
    const text = await response.text();
    return { response, text, value: text ? JSON.parse(text) : null };
  }
  async function select() {
    const target = await base.createRealmTarget('Fixed settings source', 'public');
    const source = await base.call('GET', `/v1/posts/${target.postId}`, { bearer: base.author.bearer });
    expect(source.response.status, source.text).toBe(200);
    const authored = await call('POST', `/v1/posts/${target.postId}/revisions`, {
      body: { body: rulesBody() },
      headers: { 'if-match': JSON.stringify(source.value!.post.revisionId) },
    });
    expect(authored.response.status, authored.text).toBe(200);
    const post = authored.value.post;
    const pin = { postId: target.postId, revisionId: post.revisionId as string };
    const later = await call('POST', `/v1/posts/${target.postId}/revisions`, {
      body: { body: fromPlainText('Later native rules remain unselected') },
      headers: { 'if-match': JSON.stringify(pin.revisionId) },
    });
    expect(later.response.status, later.text).toBe(200);
    const realm = await call('GET', `/v1/realms/${target.realmId}`);
    expect(realm.response.status, realm.text).toBe(200);
    return {
      ...target, pin, post, postHead: later.value.post.revisionId as string,
      head: realm.value.realm.headRevisionId as string,
      spaceId: realm.value.realm.spaceId as string,
      presentation: { ...empty, rules: pin } as Presentation,
    };
  }
  type Selected = Awaited<ReturnType<typeof select>>;
  async function patch(s: Selected, body: unknown, head = s.head, key = crypto.randomUUID(), actor = base.author) {
    return call('PATCH', `/v1/realms/${s.realmId}`, {
      bearer: actor.bearer, body, key, headers: { 'if-match': JSON.stringify(head) },
    });
  }
  async function manage(s: Selected, actor: NativePerson, revoke = false) {
    const result = await call('POST', `/v1/grants${revoke ? ':revoke' : ''}`, {
      body: {
        resource: { route: routeOf(s.realmId), id: s.realmId },
        subject: { kind: 'account', id: actor.accountId },
        actions: ['realm:manage'], valid: '(,)',
      },
    });
    expect(result.response.status, result.text).toBe(revoke ? 200 : 201);
  }
  async function snapshot(s: Selected) {
    const result = await db.admin.query(`SELECT
      (SELECT head_revision_id FROM community.realm WHERE route=$1 AND realm_id=$2) AS head,
      (SELECT count(*)::int FROM community.realm_revision WHERE route=$1 AND realm_id=$2) AS revisions,
      (SELECT count(*)::int FROM core.receipt WHERE command_kind='community.realm.update'
        AND response->>'realmId'=$2::text) AS receipts,
      (SELECT count(*)::int FROM core.outbox WHERE subject=$2::text
        AND type='com.rezics.community.realm.updated.v1') AS events,
      (SELECT head_revision_id FROM content.post WHERE route=$3 AND post_id=$4) AS post_head`,
    [routeOf(s.realmId), s.realmId, routeOf(s.postId), s.postId]);
    return result.rows[0] as { head: string; revisions: number; receipts: number; events: number; post_head: string };
  }
  async function measure(name: string, s: Selected, axis: Axis, operation: () => Promise<unknown>) {
    const route = routeOf(s.realmId)!;
    const postRoute = routeOf(s.postId)!;
    const row = async (table: string, idColumn: string, id: string, atRoute: number) =>
      (await db.admin.query(`SELECT * FROM ${table} WHERE route=$1 AND ${idColumn}=$2`, [atRoute, id])).rows[0]!;
    const space = await row('community.space', 'space_id', s.spaceId, route);
    const [spaceRevision, realm, realmRevision, revision] = await Promise.all([
      row('community.space_revision', 'revision_id', space.head_revision_id, route),
      row('community.realm', 'realm_id', s.realmId, route),
      row('community.realm_revision', 'revision_id', s.head, route),
      row('content.revision', 'revision_id', s.postHead, postRoute),
    ]);
    let predecessor = s.head;
    const seededIds: string[] = [];
    const population: Population = {
      name: `${name}-${axis}-${s.realmId}`, hotPartition: partitionOf(route), hotShare: 1,
      rows() {
        if (axis === 'rules-revisions') {
          const id = newId(postRoute);
          seededIds.push(id);
          return { 'content.revision': [{ ...revision, revision_id: id }] };
        }
        const revisionId = newId(route);
        if (axis === 'realm-revisions') {
          const previous = predecessor;
          predecessor = revisionId;
          seededIds.push(revisionId);
          return { 'community.realm_revision': [{ ...realmRevision, revision_id: revisionId, predecessor: previous }] };
        }
        const spaceId = newId(route), realmId = newId(route), spaceHead = newId(route);
        seededIds.push(realmId);
        return {
          'community.space': [{ ...space, space_id: spaceId, head_revision_id: spaceHead }],
          'community.space_revision': [{ ...spaceRevision, space_id: spaceId, revision_id: spaceHead, predecessor: null }],
          'community.realm': [{ ...realm, realm_id: realmId, space_id: spaceId, head_revision_id: revisionId }],
          'community.realm_revision': [{ ...realmRevision, realm_id: realmId, revision_id: revisionId, predecessor: null, presentation: empty }],
        };
      },
    };
    const report = await checkGrowth(db, {
      name: `Realm settings ${name} ${axis}`, scales,
      bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
      byteBounds: { requestBytes: 'constant', responseBytes: 'constant' },
      async grow(_, scale, previous) {
        const before = await snapshot(s);
        await seed(db, population, { from: previous, to: scale });
        const after = await snapshot(s);
        expect(after.head).toBe(before.head);
        expect(after.post_head).toBe(s.postHead);
        expect(after.receipts).toBe(before.receipts);
        expect(after.events).toBe(before.events);
        const [table, column, atRoute] = axis === 'unrelated-realms'
          ? ['community.realm', 'realm_id', route] as const
          : axis === 'realm-revisions'
            ? ['community.realm_revision', 'revision_id', route] as const
            : ['content.revision', 'revision_id', postRoute] as const;
        const count = await db.admin.query(`SELECT count(*)::int AS n FROM ${table} WHERE route=$1 AND ${column}=ANY($2::uuid[])`, [atRoute, seededIds]);
        expect(count.rows[0].n).toBe(scale);
      },
      operation,
    });
    expect(report.samples.map(({ scale }) => scale)).toEqual([...scales]);
    expect(new Set(report.samples.map(({ cost }) => cost.statements)).size).toBe(1);
    for (const sample of report.samples) for (const cost of sample.repetitions) {
      expect(cost.statements).toBeGreaterThan(0);
      expect(cost.blocks).toBeGreaterThan(0);
      if (name !== 'denied' && name !== 'revoked-replay')
        expect(cost.relations['community.realm']?.rows).toBeGreaterThan(0);
      // One root post, two rounds: current head, exact pin metadata and exact pin body.
      expect(cost.relations['content.revision']?.rows ?? 0).toBeLessThanOrEqual(6);
      expect(cost.relations['content.post']?.rows ?? 0).toBeLessThanOrEqual(66);
      if (name === 'adopt' || name === 'replay')
        expect(cost.relations['content.revision']?.rows).toBeGreaterThan(0);
    }
    const growing = axis === 'unrelated-realms' ? 'community.realm'
      : axis === 'realm-revisions' ? 'community.realm_revision' : 'content.revision';
    if (report.samples.every(({ cost }) => cost.relations[growing]))
      assertGrowthAccessPaths(`Realm settings ${name} ${axis}`, report.samples, [growing]);
    return report;
  }
  return {
    base, db, call, select, patch, manage, snapshot, measure,
    async close() { await db.close(); await base.system.close(); },
  };
}

export type PresentationSettingsFixture = Awaited<ReturnType<typeof presentationSettingsFixture>>;
