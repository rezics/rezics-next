import { expect } from 'bun:test';
import { fromPlainText, serializeDocument } from '@rezics/document';
import type { Access } from '../../../src/request/access.ts';
import { newId, partitionOf, routeOf } from '../../../src/route/route.ts';
import { capture, openGrowthDatabase, type Population } from '../../support/growth.ts';
import { explainPlanEntries, walkPlanTree } from '../../support/growth-plan-walk.ts';
import type { Capture } from '../../support/growth-cost.ts';
import {
  empty,
  presentationSettingsFixture,
  rulesBody,
  type Axis,
  type PresentationSettingsFixture,
} from './growth-realm-presentation-settings-fixture.ts';

type Selected = Awaited<ReturnType<PresentationSettingsFixture['select']>>;
export type SettingsAxis = Axis | 'selected-media-history' | 'authority-history';
export type SettingsBranch =
  | 'available'
  | 'empty'
  | 'denied'
  | 'revoked'
  | 'unavailable'
  | 'retry'
  | 'withheld'
  | 'deadline';

export async function settingsPageGrowthFixture() {
  let auth: Awaited<ReturnType<typeof openGrowthDatabase>> | undefined;
  const f = await presentationSettingsFixture({
    async authPoolFactory(url) {
      auth = await openGrowthDatabase(url);
      return { pool: auth.pool, close: auth.close };
    },
  });
  if (!auth) throw new Error('Settings growth requires the native Auth pool');
  const authDb = auth;

  async function select(options: { images?: boolean; maximalAncestry?: boolean } = {}) {
    const s = await f.select();
    if (options.maximalAncestry) {
      let parentId = s.postId;
      for (let depth = 1; depth < 33; depth++) {
        const reply = await f.call('POST', `/v1/threads/${s.threadId}/posts`, {
          body: {
            body: fromPlainText(`Retained rules ancestry ${depth}`),
            licence: 'MIT',
            subjectIds: [],
            parentId,
          },
        });
        expect(reply.response.status, reply.text).toBe(201);
        parentId = reply.value.post.id as string;
      }
      const source = await f.base.call('GET', `/v1/posts/${parentId}`, { bearer: f.base.author.bearer });
      expect(source.response.status, source.text).toBe(200);
      const authored = await f.call('POST', `/v1/posts/${parentId}/revisions`, {
        body: { body: rulesBody() },
        headers: { 'if-match': JSON.stringify(source.value.post.revisionId) },
      });
      expect(authored.response.status, authored.text).toBe(200);
      const pin = { postId: parentId, revisionId: authored.value.post.revisionId as string };
      const later = await f.call('POST', `/v1/posts/${parentId}/revisions`, {
        body: { body: fromPlainText('Later native rules remain unselected') },
        headers: { 'if-match': JSON.stringify(pin.revisionId) },
      });
      expect(later.response.status, later.text).toBe(200);
      s.postId = parentId;
      s.post = authored.value.post;
      s.pin = pin;
      s.postHead = later.value.post.revisionId as string;
      s.presentation = { ...s.presentation, rules: pin };
    }
    if (options.images) {
      const route = routeOf(s.realmId)!;
      const ids = [newId(route), newId(route)];
      const media = ids.map((media_id, index) => {
        const transaction_id = crypto.randomUUID();
        const digest = (index === 0 ? 'a' : 'b').repeat(64);
        return {
          route,
          media_id,
          container_id: s.realmId,
          uploader_id: f.base.author.accountId,
          reservation_request_id: `settings-growth-${s.realmId}-${index}-${crypto.randomUUID()}`,
          purpose: index === 0 ? 'realm-icon' : 'realm-banner',
          media_type: 'image/png',
          byte_count: 1,
          declared_sha256: digest,
          actual_byte_count: 1,
          sha256: digest,
          state: 'available',
          decision: null,
          key: `m/${media_id}/original`,
          claimed_at: null,
          created_at: '2025-01-01T00:00:00Z',
          transaction_id,
          erased: false,
          collection_pending: false,
          taken_down: false,
          width: 320,
          height: 240,
          thumbhash: Buffer.from([index + 1]),
          average_color: '#abcdef',
          focal_x: 0.5,
          focal_y: 0.5,
          claimed_item_id: null,
          claimed_realm_id: null,
          variants: ['avif', 'webp'].map((format, variantIndex) => ({
            route,
            media_id,
            format,
            width: 320,
            height: 240,
            media_type: `image/${format}`,
            byte_count: variantIndex + 1,
            sha256: (variantIndex === 0 ? 'c' : 'd').repeat(64),
            key: `m/${media_id}/${format}-320`,
            transaction_id,
          })),
        };
      });
      await seed(
        f.db,
        {
          name: `settings-get-images-${s.realmId}`,
          hotPartition: partitionOf(route),
          hotShare: 1,
          rows() {
            return {
              'content.media': media.map(({ variants: _variants, ...row }) => row),
              'content.media_variant': media.flatMap(({ variants }) => variants),
            };
          },
        },
        { from: 0, to: 1 },
      );
      s.presentation = { ...s.presentation, avatarMediaId: ids[0]!, bannerMediaId: ids[1]! };
    }
    return s;
  }

  async function population(s: Selected, axis: SettingsAxis): Promise<Population> {
    const route = routeOf(s.realmId)!;
    const row = async (table: string, column: string, id: string, at = route) =>
      (await f.db.admin.query(`SELECT * FROM ${table} WHERE route=$1 AND ${column}=$2`, [at, id])).rows[0]!;
    const realm = await row('community.realm', 'realm_id', s.realmId);
    const revision = await row('community.realm_revision', 'revision_id', s.head);
    const space = await row('community.space', 'space_id', s.spaceId);
    const spaceRevision = await row('community.space_revision', 'revision_id', space.head_revision_id);
    const postRoute = routeOf(s.postId)!;
    const postRevision = await row('content.revision', 'revision_id', s.postHead, postRoute);
    const selectedMediaId = s.presentation.avatarMediaId;
    const mediaTemplate =
      axis === 'selected-media-history' && selectedMediaId
        ? await row('content.media', 'media_id', selectedMediaId)
        : undefined;
    const variantTemplates =
      axis === 'selected-media-history' && selectedMediaId
        ? (
            await f.db.admin.query('SELECT * FROM content.media_variant WHERE route=$1 AND media_id=$2', [
              route,
              selectedMediaId,
            ])
          ).rows
        : [];
    let predecessor = s.head;
    return {
      name: `settings-get-${axis}-${s.realmId}`,
      hotPartition: partitionOf(route),
      hotShare: 1,
      rows({ ordinal }) {
        const revisionId = newId(route);
        if (axis === 'rules-revisions')
          return { 'content.revision': [{ ...postRevision, revision_id: newId(postRoute) }] };
        if (axis === 'realm-revisions') {
          const previous = predecessor;
          predecessor = revisionId;
          return { 'community.realm_revision': [{ ...revision, revision_id: revisionId, predecessor: previous }] };
        }
        if (axis === 'selected-media-history') {
          if (!mediaTemplate) throw new Error('Selected media history needs a claimed image template');
          const mediaId = newId(route);
          const transactionId = crypto.randomUUID();
          return {
            'content.media': [
              {
                ...mediaTemplate,
                media_id: mediaId,
                reservation_request_id: `settings-media-history-${s.realmId}-${ordinal}-${crypto.randomUUID()}`,
                key: `m/${mediaId}/original`,
                claimed_at: '2025-01-01T00:00:00Z',
                claimed_realm_id: s.realmId,
                created_at: '2024-01-01T00:00:00Z',
                transaction_id: transactionId,
              },
            ],
            'content.media_variant': variantTemplates.map((variant) => ({
              ...variant,
              media_id: mediaId,
              key: `m/${mediaId}/${variant.format}-${variant.width}`,
              transaction_id: transactionId,
            })),
          };
        }
        if (axis === 'authority-history') {
          const transactionId = crypto.randomUUID();
          const start = new Date(Date.UTC(2000, 0, 1) + ordinal * 2_000).toISOString();
          const end = new Date(Date.parse(start) + 1_000).toISOString();
          return {
            'access.resource_grant': [
              {
                route,
                resource_id: s.realmId,
                subject_kind: 'identity',
                subject_id: f.base.author.accountId,
                subject_role: '',
                action: 'realm:manage',
                valid: `["${start}","${end}")`,
                transaction_id: transactionId,
              },
            ],
          };
        }
        if (axis === 'unrelated-realms') {
          const realmId = newId(route),
            spaceId = newId(route),
            head = newId(route);
          return {
            'community.space': [{ ...space, space_id: spaceId, head_revision_id: head }],
            'community.space_revision': [{ ...spaceRevision, space_id: spaceId, revision_id: head, predecessor: null }],
            'community.realm': [{ ...realm, realm_id: realmId, space_id: spaceId, head_revision_id: revisionId }],
            'community.realm_revision': [
              { ...revision, realm_id: realmId, revision_id: revisionId, predecessor: null, presentation: empty },
            ],
          };
        }
        throw new Error(`Unsupported settings growth axis: ${axis}`);
      },
    };
  }

  async function snapshot(s: Selected) {
    const current = await f.snapshot(s);
    const ids = [s.presentation.avatarMediaId, s.presentation.bannerMediaId].filter((id): id is string => id !== null);
    const result = await f.db.admin.query(
      `SELECT
        (SELECT count(*)::int FROM content.media WHERE route=$1 AND media_id=ANY($2::uuid[])) AS media_rows,
        (SELECT count(*)::int FROM content.media_variant WHERE route=$1 AND media_id=ANY($2::uuid[])) AS variant_rows`,
      [routeOf(s.realmId), ids],
    );
    return { ...current, ...result.rows[0] } as typeof current & { media_rows: number; variant_rows: number };
  }

  async function historyCount(s: Selected, axis: SettingsAxis): Promise<number> {
    const route = routeOf(s.realmId)!;
    const result =
      axis === 'selected-media-history'
        ? await f.db.admin.query(
            `SELECT
               (SELECT count(*)::int FROM content.media
                WHERE route=$1 AND container_id=$2 AND reservation_request_id LIKE $3) AS n,
               (SELECT count(*)::int FROM content.media_variant v JOIN content.media m USING(route,media_id)
                WHERE m.route=$1 AND m.container_id=$2 AND m.reservation_request_id LIKE $3) AS variants`,
            [route, s.realmId, `settings-media-history-${s.realmId}-%`],
          )
        : axis === 'authority-history'
          ? await f.db.admin.query(
              `SELECT count(*)::int AS n FROM access.resource_grant
               WHERE route=$1 AND resource_id=$2 AND subject_id=$3 AND action='realm:manage'
                 AND lower(valid)>='2000-01-01'::timestamptz AND lower(valid)<'2000-01-02'::timestamptz`,
              [route, s.realmId, f.base.author.accountId],
            )
          : null;
    if (!result) throw new Error(`No history counter for ${axis}`);
    if (axis === 'selected-media-history') expect(result.rows[0]!.variants).toBe(2 * (result.rows[0]!.n as number));
    return result.rows[0]!.n as number;
  }

  async function read(s: Selected, branch: SettingsBranch, failOptional = branch === 'unavailable') {
    const network = { jwksRequestBytes: 0, jwksResponseBytes: 0 };
    const native = f.base.system.createFreshAccess(async (request, response) => {
      network.jwksRequestBytes += requestBytes(request);
      network.jwksResponseBytes += responseBytes(response, await response.text());
    });
    const counts = { preparations: 0, rulesPreparations: 0, rulesFormulas: 0 };
    let manage = 0;
    let deadlineAdvance = 0;
    const access: Access = {
      ...native,
      async prepare(actor, action, resource, context) {
        counts.preparations++;
        if (action === 'realm:manage' && branch === 'deadline') deadlineAdvance = 60_000;
        if (action === 'realm:manage' && ++manage === 2 && branch === 'withheld')
          throw new Error('Final settings authority dependency unavailable');
        return native.prepare!(actor, action, resource, context);
      },
      async prepareReadDecisions(input) {
        counts.rulesPreparations++;
        if (failOptional) throw new Error('Selected rules dependency unavailable');
        const decisions = await native.prepareReadDecisions!(input);
        return {
          ...decisions,
          async decide(...args) {
            counts.rulesFormulas++;
            return decisions.decide(...args);
          },
        };
      },
    };
    const kernel = f.base.system.createKernelForPool(f.db.pool, access);
    const actor = branch === 'denied' || branch === 'revoked' ? f.base.other : f.base.author;
    const request = new Request(`https://content.test/v1/realms/${s.realmId}/settings`, {
      headers: { authorization: `Bearer ${actor.bearer}` },
    });
    const observed = await capture(
      authDb,
      async () => {
        const nativeNow = Date.now;
        let response: Response;
        if (branch === 'deadline') Date.now = () => nativeNow() + deadlineAdvance;
        try {
          response = await kernel.handle(request);
        } finally {
          Date.now = nativeNow;
        }
        const body = await response.text();
        expect(response.status, body).toBe(
          branch === 'withheld' || branch === 'deadline' ? 503 : actor === f.base.other ? 404 : 200,
        );
        if (response.status !== 200) {
          expect(body).not.toContain(s.post.sha256);
          expect(body).not.toContain(s.pin.revisionId);
        } else {
          const page = JSON.parse(body);
          expect(response.headers.get('etag')).toBe(JSON.stringify(s.head));
          expect(response.headers.get('cache-control')).toBe('private, no-store');
          expect(page.snapshot.head).toBe(s.head);
          for (const [slot, id] of [
            ['avatar', s.presentation.avatarMediaId],
            ['banner', s.presentation.bannerMediaId],
          ] as const) {
            if (id === null) expect(page.snapshot[slot]).toEqual({ state: 'none', value: null });
            else {
              expect(page.snapshot[slot].state).toBe('available');
              expect(page.snapshot[slot].value).toMatchObject({ id, containerId: s.realmId });
            }
          }
          expect(page.snapshot.rules.state).toBe(
            branch === 'empty' ? 'none' : failOptional ? 'unavailable' : 'available',
          );
          if (branch !== 'empty') expect(page.snapshot.presentation.rules).toEqual(s.pin);
          if (!failOptional && branch !== 'empty') {
            expect(page.snapshot.rules.value.sha256).toBe(s.post.sha256);
            expect(counts).toEqual({
              preparations: 7 + (s.presentation.avatarMediaId === null ? 0 : 10),
              rulesPreparations: 2,
              rulesFormulas: 16,
            });
          }
        }
        return responseBytes(response, body);
      },
      { includeBackends: true },
    );
    return {
      authCapture: observed.capture,
      applicationRequestBytes: requestBytes(request),
      applicationResponseBytes: observed.value,
      ...network,
    };
  }
  async function readAuthoring(s: Selected) {
    const network = { jwksRequestBytes: 0, jwksResponseBytes: 0 };
    const access = f.base.system.createFreshAccess(async (request, response) => {
      network.jwksRequestBytes += requestBytes(request);
      network.jwksResponseBytes += responseBytes(response, await response.text());
    });
    const kernel = f.base.system.createKernelForPool(f.db.pool, access);
    const request = new Request(`https://content.test/v1/realms/${s.realmId}/rulesAuthoring`, {
      headers: { authorization: `Bearer ${f.base.author.bearer}` },
    });
    const observed = await capture(
      authDb,
      async () => {
        const response = await kernel.handle(request);
        const body = await response.text();
        expect(response.status, body).toBe(200);
        expect(response.headers.get('cache-control')).toBe('private, no-store');
        const page = JSON.parse(body);
        expect(page.realm.realmId).toBe(s.realmId);
        expect(page.current.reference).toEqual(s.pin);
        expect(page.destinations.items.length).toBeLessThanOrEqual(20);
        expect(Buffer.byteLength(serializeDocument(page.current.body))).toBe(65_536);
        return responseBytes(response, body);
      },
      { includeBackends: true },
    );
    return {
      authCapture: observed.capture,
      applicationRequestBytes: requestBytes(request),
      applicationResponseBytes: observed.value,
      ...network,
    };
  }
  return { ...f, select, population, historyCount, snapshot, read, readAuthoring };
}

function wireBytes(start: string, headers: Headers, body = '') {
  return Buffer.byteLength(
    `${start}\r\n${[...headers].map(([key, value]) => `${key}: ${value}\r\n`).join('')}\r\n${body}`,
  );
}

function requestBytes(request: Request) {
  const url = new URL(request.url),
    headers = new Headers(request.headers);
  if (!headers.has('host')) headers.set('host', url.host);
  return wireBytes(`${request.method} ${url.pathname}${url.search} HTTP/1.1`, headers);
}

function responseBytes(response: Response, body: string) {
  return wireBytes(`HTTP/1.1 ${response.status} ${response.statusText}`, response.headers, body);
}

/** Direct current-head joins must use the routed exact revision key. The owner-ID
 * equality remains a residual check when PostgreSQL chooses the two-column PK. */
export function assertSettingsSourcePrefixes(capture: Capture, axis: Axis) {
  const relations =
    axis === 'unrelated-realms'
      ? ['realm_revision', 'space_revision']
      : axis === 'realm-revisions'
        ? ['realm_revision']
        : ['revision'];
  const schema = axis === 'rules-revisions' ? 'content' : 'community';
  let checked = 0;
  for (const document of capture.plans)
    for (const { plan } of explainPlanEntries(document)) {
      for (const { node } of walkPlanTree(plan)) {
        if (node.Schema !== schema || !relations.includes(String(node['Relation Name']))) continue;
        checked++;
        // Bitmap heap scans retain the routed equality on their index child.
        // Residual Filter/Recheck Cond expressions alone never satisfy this proof.
        const conditions = [...walkPlanTree(node)].map(({ node: index }) => String(index['Index Cond'] ?? ''));
        expect(
          conditions.some((condition) => /\broute\s*=/.test(condition) && /\brevision_id\s*=/.test(condition)),
        ).toBe(true);
      }
    }
  expect(checked).toBeGreaterThan(0);
}
