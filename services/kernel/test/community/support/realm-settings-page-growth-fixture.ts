import { expect } from 'bun:test';
import type { Access } from '../../../src/request/access.ts';
import { newId, partitionOf, routeOf } from '../../../src/route/route.ts';
import { capture, openGrowthDatabase, type Population } from '../../support/growth.ts';
import { explainPlanEntries, walkPlanTree } from '../../support/growth-plan-walk.ts';
import type { Capture } from '../../support/growth-cost.ts';
import { presentationSettingsFixture, type Axis, type PresentationSettingsFixture } from './growth-realm-presentation-settings-fixture.ts';

type Selected = Awaited<ReturnType<PresentationSettingsFixture['select']>>;
export type SettingsBranch = 'available' | 'empty' | 'denied' | 'revoked' | 'unavailable' | 'retry' | 'withheld';

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

  async function population(s: Selected, axis: Axis): Promise<Population> {
    const route = routeOf(s.realmId)!;
    const row = async (table: string, column: string, id: string, at = route) =>
      (await f.db.admin.query(`SELECT * FROM ${table} WHERE route=$1 AND ${column}=$2`, [at, id])).rows[0]!;
    const realm = await row('community.realm', 'realm_id', s.realmId);
    const revision = await row('community.realm_revision', 'revision_id', s.head);
    const space = await row('community.space', 'space_id', s.spaceId);
    const spaceRevision = await row('community.space_revision', 'revision_id', space.head_revision_id);
    const postRoute = routeOf(s.postId)!;
    const postRevision = await row('content.revision', 'revision_id', s.postHead, postRoute);
    let predecessor = s.head;
    return {
      name: `settings-get-${axis}-${s.realmId}`,
      hotPartition: partitionOf(route),
      hotShare: 1,
      rows() {
        const revisionId = newId(route);
        if (axis === 'rules-revisions')
          return { 'content.revision': [{ ...postRevision, revision_id: newId(postRoute) }] };
        if (axis === 'realm-revisions') {
          const previous = predecessor;
          predecessor = revisionId;
          return { 'community.realm_revision': [{ ...revision, revision_id: revisionId, predecessor: previous }] };
        }
        const realmId = newId(route), spaceId = newId(route), head = newId(route);
        return {
          'community.space': [{ ...space, space_id: spaceId, head_revision_id: head }],
          'community.space_revision': [{ ...spaceRevision, space_id: spaceId, revision_id: head, predecessor: null }],
          'community.realm': [{ ...realm, realm_id: realmId, space_id: spaceId, head_revision_id: revisionId }],
          'community.realm_revision': [{ ...revision, realm_id: realmId, revision_id: revisionId, predecessor: null }],
        };
      },
    };
  }

  async function read(s: Selected, branch: SettingsBranch, failOptional = branch === 'unavailable') {
    const network = { jwksRequestBytes: 0, jwksResponseBytes: 0 };
    const native = f.base.system.createFreshAccess(async (request, response) => {
      network.jwksRequestBytes += requestBytes(request);
      network.jwksResponseBytes += responseBytes(response, await response.text());
    });
    const counts = { preparations: 0, rulesPreparations: 0, rulesFormulas: 0 };
    let manage = 0;
    const access: Access = {
      ...native,
      async prepare(actor, action, resource, context) {
        counts.preparations++;
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
    const observed = await capture(authDb, async () => {
      const response = await kernel.handle(request);
      const body = await response.text();
      expect(response.status, body).toBe(branch === 'withheld' ? 503 : actor === f.base.other ? 404 : 200);
      if (response.status !== 200) {
        expect(body).not.toContain(s.post.sha256);
        expect(body).not.toContain(s.pin.revisionId);
      } else {
        const page = JSON.parse(body);
        expect(response.headers.get('etag')).toBe(JSON.stringify(s.head));
        expect(response.headers.get('cache-control')).toBe('private, no-store');
        expect(page.snapshot.head).toBe(s.head);
        expect(page.snapshot.avatar).toEqual({ state: 'none', value: null });
        expect(page.snapshot.banner).toEqual({ state: 'none', value: null });
        expect(page.snapshot.rules.state).toBe(branch === 'empty' ? 'none' : failOptional ? 'unavailable' : 'available');
        if (branch !== 'empty') expect(page.snapshot.presentation.rules).toEqual(s.pin);
        if (!failOptional && branch !== 'empty') {
          expect(page.snapshot.rules.value.sha256).toBe(s.post.sha256);
          expect(counts).toEqual({ preparations: 7, rulesPreparations: 2, rulesFormulas: 16 });
        }
      }
      return responseBytes(response, body);
    }, { includeBackends: true });
    return {
      authCapture: observed.capture,
      applicationRequestBytes: requestBytes(request),
      applicationResponseBytes: observed.value,
      ...network,
    };
  }
  return { ...f, population, read };
}

function wireBytes(start: string, headers: Headers, body = '') {
  return Buffer.byteLength(`${start}\r\n${[...headers].map(([key, value]) => `${key}: ${value}\r\n`).join('')}\r\n${body}`);
}

function requestBytes(request: Request) {
  const url = new URL(request.url), headers = new Headers(request.headers);
  if (!headers.has('host')) headers.set('host', url.host);
  return wireBytes(`${request.method} ${url.pathname}${url.search} HTTP/1.1`, headers);
}

function responseBytes(response: Response, body: string) {
  return wireBytes(`HTTP/1.1 ${response.status} ${response.statusText}`, response.headers, body);
}

/** Direct current-head joins must use the routed exact revision key. The owner-ID
 * equality remains a residual check when PostgreSQL chooses the two-column PK. */
export function assertSettingsSourcePrefixes(capture: Capture, axis: Axis) {
  const relations = axis === 'unrelated-realms' ? ['realm_revision', 'space_revision']
    : axis === 'realm-revisions' ? ['realm_revision'] : ['revision'];
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
        expect(conditions.some((condition) => /\broute\s*=/.test(condition) && /\brevision_id\s*=/.test(condition))).toBe(true);
      }
    }
  expect(checked).toBeGreaterThan(0);
}
