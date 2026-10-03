import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createMainApp } from '../../../services/main/src/app.ts';
import { DiscoveryProjection } from '../../../services/main/src/modules/discovery/store.ts';
import { automaticDiscovery } from '../../../services/main/src/modules/discovery/automation.ts';
import { projectDiscoveryBatch } from '../../../services/main/src/modules/discovery/source.ts';
import { workRead } from '../../../services/main/src/modules/work/read-session.ts';
import { ProfilesAccess } from '../../../services/main/src/modules/profiles/access.ts';
import { GLOBAL_CONTEXT_SCOPE } from '../../../services/main/src/modules/rating/global.ts';
import { GRAPHS, RV, iri } from '../../../services/main/src/modules/work/activate.ts';
import { RecommendationUnavailable } from '../../../services/main/src/modules/recommendation/derived-generation.ts';
import { MediaUnavailable } from '../../../services/main/src/modules/media/store.ts';
import { resourceListPage } from '../../../services/main/src/modules/query/resource-contract.ts';
import { digest } from '../../../services/main/src/modules/recommendation/derived-generation.ts';
import { Value } from 'typebox/value';
import type { Static } from 'typebox';
import { startMediaStack } from './media-support.ts';

async function json<T>(response: Response, status = 200): Promise<T> {
  const text = await response.text();
  expect(response.status, text).toBe(status);
  return JSON.parse(text) as T;
}

test('G1011: Query keeps Works and continuation when item credits, ratings or covers cannot be read', async () => {
  const started = performance.now();
  const f = await startMediaStack('g-1011-optional', { profileCredits: true, library: true });
  try {
    const bad = await f.member('G1011 affected author'), good = await f.member('G1011 healthy author');
    const works = await Promise.all([
      f.publicWork(bad.actor, ['en'], 'G1011 affected Work'),
      f.publicWork(good.actor, ['en'], 'G1011 healthy Work'),
    ]);
    for (const [index, member] of [bad, good].entries()) {
      const work = works[index]!;
      const head = (await f.fuseki.query(`PREFIX rv: <${RV}> SELECT ?head WHERE {
        GRAPH ${iri(GRAPHS.current)} { ${iri(work.work)} rv:head ?head } }`)).results!.bindings[0]!.head!.value;
      await member.grant(`work:edit:${work.work}`, 'work.edit');
      const app = createMainApp(f.fuseki, { environment: f.env, access: f.access,
        profiles: new ProfilesAccess(f.accessPool), account: { verify: async () => member.principal } });
      await json(await app.handle(new Request(`http://main.local/v1/works/${work.work.slice(-36)}/agent-credits`, {
        method: 'POST', headers: { authorization: `Bearer ${member.token}`, 'content-type': 'application/json',
          'idempotency-key': randomUUID() }, body: JSON.stringify({ profile: 'native-agent-credit-v1',
          credit: `https://rezics.com/id/${randomUUID()}`, agent: member.actor, role: 'author',
          expectedWorkHead: head, actingSubject: member.actor }),
      })), 201);
    }
    await bad.grant(GLOBAL_CONTEXT_SCOPE, 'rating.context.create');
    const global = await json<{ context: string }>(await bad.send('POST', '/v1/global-rating-contexts', {
      profile: 'global-rating-standing-context-v1', question: 'G1011 Overall quality', actingSubject: bad.actor,
    }, randomUUID()), 201);
    await bad.grant(`rating:observe:${global.context}`, 'rating.observation.set');
    for (const work of works) await json(await bad.send('POST', '/v1/global-rating-observations', {
      profile: 'global-rating-standing-observation-v1', context: global.context, work: work.work,
      mainVersion: work.mainVersion, value: 4, expectedRevisionHead: null, actingSubject: bad.actor,
    }, randomUUID()), 201);
    const projection = new DiscoveryProjection(f.accessPool);
    const deps = { environment: f.env, access: f.access, media: f.media, profiles: new ProfilesAccess(f.accessPool),
      discovery: projection, account: { verify: async () => bad.principal } };
    await workRead(deps, new Request('http://main.local/source'), {}, async session => {
      for (const context of [null, global.context]) {
        const basis = { scope: 'global' as const, realm: null, context };
        const row = await projection.register(automaticDiscovery(null), basis, session.position,
          { idempotencyKey: randomUUID(), requestDigest: digest(basis) });
        const step = await projection.beginStep(automaticDiscovery(null), row.generation_id, '');
        const batch = await projectDiscoveryBatch(session, basis, '', { works: works.map(work => work.work).sort() });
        expect(batch.complete).toBe(true);
        await projection.commitBatch(automaticDiscovery(null), row.generation_id, step.lease, '', batch, session.position);
        await projection.activate(automaticDiscovery(null), row.generation_id, null, session.position,
          { idempotencyKey: randomUUID(), requestDigest: digest(row.generation_id) });
      }
    });
    expect(performance.now() - started).toBeLessThan(600_000);
    const app = createMainApp(f.fuseki, deps);
    const request = async (limit = 20, cursor?: string) => {
      const response = await app.handle(new Request('http://main.local/v1/query', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
          profile: 'resource-list-v1', context: 'global', scope: { kind: 'all' }, sort: 'newest', limit, cursor,
          filter: { all: [{ facet: 'type', any: ['https://schema.org/CreativeWork'] }] },
        }),
      }));
      const result = (await json<{ result: Static<typeof resourceListPage> }>(response)).result;
      expect(Value.Check(resourceListPage, result)).toBe(true);
      return result;
    };
    const baseline = await request();
    expect(baseline.items).toHaveLength(2);
    const ids = baseline.items.map(item => item.id);
    for (const item of baseline.items) {
      expect(item.work!.primaryCredits).toHaveLength(1);
      expect(item.work!.rating).toMatchObject({ context: global.context, mean: 4, count: 1 });
    }
    const first = await request(1);
    expect(first.complete).toBe(false);
    const payloads = projection.resourceCardPayloads.bind(projection);
    const active = projection.active.bind(projection);
    const avatars = f.media.store.avatarRows.bind(f.media.store);
    try {
      // Fault a single optional payload, preserving the actual owner read and
      // all immutable membership rows. Its healthy neighbour must stay rich.
      projection.resourceCardPayloads = async (generations, selected) => {
        const rows = await payloads(generations, selected);
        for (const own of rows.values()) {
          const row = own.get(works[0]!.work);
          if (row) own.set(works[0]!.work, { ...row,
            primaryCredits: [null] as never, rating: row.rating ? { ...row.rating, mean: 99 } : null });
        }
        return rows;
      };
      let result = await request();
      expect(result.items.map(item => item.id)).toEqual(ids);
      const affected = result.items.find(item => item.id === works[0]!.work)!;
      const healthy = result.items.find(item => item.id === works[1]!.work)!;
      expect(affected.work).toEqual({ primaryCredits: [], creditCount: { value: 0, kind: 'at-least' }, rating: null });
      expect(healthy.work).toEqual(baseline.items.find(item => item.id === healthy.id)!.work);
      const continued = await request(1, first.nextCursor!);
      expect(continued.items.map(item => item.id)).toEqual([ids[1]!]);
      let tail = continued;
      const traversed = [...first.items, ...continued.items];
      for (let page = 0; !tail.complete && page < 4; page++) {
        tail = await request(1, tail.nextCursor!);
        traversed.push(...tail.items);
      }
      expect(tail.complete).toBe(true);
      expect(traversed.map(item => item.id)).toEqual(ids);
      projection.resourceCardPayloads = payloads;
      projection.active = async (basis, position, pinned) => {
        if (basis.context) throw new RecommendationUnavailable('G1011 optional rating owner unavailable');
        return active(basis, position, pinned);
      };
      result = await request();
      expect(result.items.map(item => item.id)).toEqual(ids);
      for (const item of result.items) {
        expect(item.work!.primaryCredits).toHaveLength(1);
        expect(item.work!.rating).toBeNull();
      }
      projection.active = active;
      projection.active = async (basis, position, pinned) => {
        const row = await active(basis, position, pinned);
        return { ...row, stale: basis.context ? true : row.stale };
      };
      result = await request();
      expect(result.items.map(item => item.id)).toEqual(ids);
      for (const item of result.items) {
        expect(item.work!.primaryCredits).toHaveLength(1);
        expect(item.work!.rating).toBeNull();
      }
      projection.active = active;
      f.media.store.avatarRows = async () => { throw new MediaUnavailable('G1011 optional cover owner unavailable'); };
      result = await request();
      expect(result.items.map(item => item.id)).toEqual(ids);
      for (const item of result.items) {
        expect(item.icon.kind).toBe('fallback');
        expect(item.name).toEqual(baseline.items.find(original => original.id === item.id)!.name);
        expect(item.work).toEqual(baseline.items.find(original => original.id === item.id)!.work);
      }
      f.media.store.avatarRows = avatars;
      projection.active = async (basis, position, pinned) => {
        const row = await active(basis, position, pinned);
        return { ...row, stale: basis.context ? row.stale : true };
      };
      result = await request();
      expect(result.items.map(item => item.id)).toEqual(ids);
      expect(result.stale).toBe(true);
      for (const item of result.items) {
        expect(item.work!.primaryCredits).toEqual([]);
        expect(item.work!.creditCount).toEqual({ value: 0, kind: 'at-least' });
        expect(item.work!.rating).toMatchObject({ mean: 4 });
      }
    } finally {
      projection.resourceCardPayloads = payloads;
      projection.active = active;
      f.media.store.avatarRows = avatars;
    }
    expect(await request()).toEqual(baseline);
    // Required catalogue membership remains authoritative during outages.
    projection.resourceMembership = async () => { throw new RecommendationUnavailable('Membership unavailable'); };
    await json(await app.handle(new Request('http://main.local/v1/query', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ profile: 'resource-list-v1',
        context: 'global', scope: { kind: 'all' }, sort: 'newest', limit: 20,
        filter: { all: [{ facet: 'type', any: ['https://schema.org/CreativeWork'] }] } }),
    })), 503);
  } finally { await f.stop(); }
}, 600_000);
