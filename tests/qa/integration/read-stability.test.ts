import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createMainApp } from '../../../services/main/src/app.ts';
import { fusekiReadBudget } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AgentProvisioning } from '../../../services/main/src/modules/agent/provision.ts';
import { ProfilesAccess } from '../../../services/main/src/modules/profiles/access.ts';
import { ReaderLibraryStatusStore } from '../../../services/main/src/modules/library/status.ts';
import { ReaderLibraryRatings } from '../../../services/main/src/modules/library/ratings.ts';
import { FollowsStore } from '../../../services/main/src/modules/follows/store.ts';
import { automaticDiscovery } from '../../../services/main/src/modules/discovery/automation.ts';
import { DiscoveryProjection } from '../../../services/main/src/modules/discovery/store.ts';
import { DiscoveryRefreshStore } from '../../../services/main/src/modules/discovery/refresh-store.ts';
import { projectDiscoveryWork } from '../../../services/main/src/modules/discovery/source.ts';
import { workRead } from '../../../services/main/src/modules/work/read-session.ts';
import { GRAPHS, iri } from '../../../services/main/src/modules/work/activate.ts';
import { sha, startMediaStack } from './media-support.ts';

async function json<T>(response: Response, status = 200): Promise<T> {
  const body = await response.text();
  expect(response.status, body).toBe(status);
  return JSON.parse(body) as T;
}
interface Page { generation: string; stale: boolean; items: { id: string; title: { value: string } }[];
  nextCursor: string | null }

test('G323 first pages survive a concurrent command burst; discovery retains its generation and rechecks disclosure', async () => {
  const stack = await startMediaStack('read-stability');
  try {
    const member = await stack.member('reader');
    const projection = new DiscoveryProjection(stack.accessPool);
    const deps = { environment: stack.env, access: stack.access, media: stack.media,
      account: { verify: async () => ({ ...member.principal, emailVerified: true }) }, discovery: projection,
      profiles: new ProfilesAccess(stack.accessPool),
      agentProvisioning: new AgentProvisioning(stack.accessPool, stack.env),
      libraryStatus: new ReaderLibraryStatusStore(stack.contentPool),
      libraryRatings: new ReaderLibraryRatings(stack.accessPool), follows: new FollowsStore(stack.accessPool) };
    const app = createMainApp(stack.fuseki, deps);
    const agent = await json<{ agent: string }>(await app.handle(new Request('http://main.local/v1/agents', {
      method: 'POST', headers: { authorization: 'Bearer reader', 'content-type': 'application/json',
        'idempotency-key': randomUUID() },
      body: JSON.stringify({ profile: 'agent-provision-v1', kind: 'person', displayName: 'Stable reader' }),
    })), 201);
    const first = await stack.publicWork(agent.agent, ['en'], 'First stable Work');
    await stack.publicWork(agent.agent, ['en'], 'Second stable Work');
    await member.grant('space:create:root', 'space.create');
    const realm = await json<{ realm: string; space: string }>(await member.send('POST', '/v1/spaces', {
      profile: 'space-realm-v1', name: 'Stable Realm', capabilities: ['realm'], actingSubject: member.actor,
    }), 201);
    const basis = { scope: 'global' as const, realm: null, context: null };
    const operator = automaticDiscovery(null);
    const build = () => workRead(deps, new Request('http://main.internal/read-stability-build'), {}, async session => {
      let row = await projection.register(operator, basis, session.position,
        { idempotencyKey: randomUUID(), requestDigest: sha(randomUUID()) });
      for (let i = 0; !row.complete && i < 10; i++) {
        const step = await projection.beginStep(operator, row.generation_id, row.checkpoint);
        row = { ...await projection.commitStep(operator, row.generation_id, step.lease, row.checkpoint,
          await projectDiscoveryWork(session, basis, row.checkpoint), session.position), replayed: false };
      }
      expect(row.complete).toBe(true);
      await projection.activate(operator, row.generation_id, row.active_head, session.position,
        { idempotencyKey: randomUUID(), requestDigest: sha(randomUUID()) });
      return row;
    });
    await build();
    const get = (path: string, authenticated = false) => app.handle(new Request(`http://main.local${path}`,
      { headers: authenticated ? { authorization: 'Bearer reader' } : {} }));
    const page = await json<Page>(await get('/v1/works?limit=1'));
    expect(page.stale).toBe(false);
    expect(page.nextCursor).not.toBeNull();

    // A command burst lands after the first graph position was captured. The
    // relay is deliberately not drained before reading the completed projection.
    const originalQuery = stack.fuseki.query.bind(stack.fuseki);
    let writes: Promise<unknown[]> | undefined;
    stack.fuseki.query = async (sparql, bytes) => {
      const result = await originalQuery(sparql, bytes);
      if (!writes && sparql.includes('SELECT ?epoch ?sequence WHERE')) {
        writes = fusekiReadBudget.exit(() => Promise.all(Array.from({ length: 8 }, (_, n) =>
          stack.privateWork(agent.agent, `Concurrent private Work ${n}`))));
        await writes;
      }
      return result;
    };
    try {
      const paths = ['/v1/works?limit=5', `/v1/agents/${agent.agent.slice(-36)}`,
        `/v1/works/${first.work.slice(-36)}/agent-credits`,
        `/v1/follows/${realm.realm.slice(-36)}?kind=realm`,
        `/v1/works/${first.work.slice(-36)}/reader-state?actingSubject=${encodeURIComponent(agent.agent)}`];
      const responses = await Promise.all(paths.map((path, index) => get(path, index === 4)));
      for (const [index, response] of responses.entries()) {
        expect(response.status, paths[index]).toBe(200);
        await json(response);
      }
      expect(writes).toBeDefined();
      await writes;
    } finally { stack.fuseki.query = originalQuery; }

    const stale = await json<Page>(await get('/v1/works?limit=5'));
    expect(stale.stale).toBe(true);
    expect(stale.generation).toBe(page.generation);
    expect(stale.items).toHaveLength(2);
    expect(JSON.stringify(stale)).not.toContain('Concurrent private Work');

    // More activations than the count retention limit cannot purge a live cursor.
    for (let n = 0; n < 3; n++) await build();
    const refresh = new DiscoveryRefreshStore(stack.accessPool);
    expect(await refresh.purge()).toBe(0);
    const continued = await json<Page>(await get(`/v1/works?cursor=${page.nextCursor}`));
    expect(continued.generation).toBe(page.generation);
    expect(continued.items).toHaveLength(1);
    expect(continued.items[0]!.id).not.toBe(page.items[0]!.id);
    const hidden = continued.items[0]!.id;
    await stack.fuseki.update(`PREFIX rv: <https://rezics.com/vocab/> INSERT DATA {
      GRAPH ${iri(GRAPHS.current)} { <urn:rezics:stability-variant> rv:resource ${iri(hidden)} ;
        rv:contentPublicationHead <urn:rezics:stability-pin> }
      GRAPH ${iri(GRAPHS.revisions)} { <urn:rezics:stability-pin> rv:contentRevision <urn:rezics:stability-erased> .
        <urn:rezics:stability-erased> a rv:ErasedRevision } }`);
    expect((await json<Page>(await get(`/v1/works?cursor=${page.nextCursor}`))).items).toEqual([]);
    await stack.accessPool.query(`UPDATE access.derived_generation SET finished_at = clock_timestamp() - interval '6 minutes'
      WHERE id = $1`, [page.generation]);
    expect((await get(`/v1/works?cursor=${page.nextCursor}`)).status).toBe(409);
    expect(await refresh.purge()).toBeGreaterThan(0);
  } finally { await stack.stop(); }
}, 240_000);
