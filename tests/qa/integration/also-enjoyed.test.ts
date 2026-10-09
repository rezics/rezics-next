import { randomUUID } from 'node:crypto';
import { expect, test } from 'bun:test';
import { createMainApp } from '../../../services/main/src/app.ts';
import { fusekiReadBudget } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AlsoEnjoyedStore, ALSO_ENJOYED_COST } from '../../../services/main/src/modules/also-enjoyed/store.ts';
import { GLOBAL_CONTEXT_SCOPE } from '../../../services/main/src/modules/rating/global.ts';
import { decodeReadCursor } from '../../../services/main/src/modules/work/read-session.ts';
import { WORK_READ_COST } from '../../../services/main/src/modules/work/read-contract.ts';
import { MANAGE_ACTION, MANAGE_SCOPE } from '../../../services/main/src/modules/recommendation/derived-generation.ts';
import { GRAPHS, RV, iri } from '../../../services/main/src/modules/work/activate.ts';
import { startMediaStack } from './media-support.ts';

async function json<T>(response: Response, status = 200): Promise<T> {
  const value = await response.text();
  if (response.status !== status) throw new Error(`${response.status}: ${value}`);
  return JSON.parse(value) as T;
}

const BOOK = 'https://schema.org/Book';
const GUIDE = 'https://schema.org/DigitalDocument';
const MOD = 'https://rezics.com/vocab/ModPackage';

test('Also enjoyed: public shelf overlap, fallback, exclusions and visibility revocation', async () => {
  const stack = await startMediaStack('also-enjoyed', { profileCredits: true });
  try {
    const manager = await stack.member('manager');
    await manager.grant(MANAGE_SCOPE, MANAGE_ACTION);
    const source = await stack.publicWork(manager.actor, ['en'], 'A public source book');
    const candidate = await stack.publicWork(manager.actor, ['en'], 'A co-read book');
    const unrelated = await stack.publicWork(manager.actor, ['en'], 'A co-read software guide');
    const modSource = await stack.publicWork(manager.actor, ['en'], 'A source mod');
    const modCandidate = await stack.publicWork(manager.actor, ['en'], 'Another mod');
    const another = await stack.publicWork(manager.actor, ['en'], 'Another similar book');
    const sameAuthor = await stack.publicWork(manager.actor, ['en'], 'A second book by the author');
    const chapter = await stack.publicWork(manager.actor, ['en'], 'A chapter Work');
    const hidden = await stack.privateWork(manager.actor, 'A private Work');
    const workHead = async (work: string) => {
      const head = (await stack.fuseki.query(`PREFIX rv: <${RV}> SELECT ?head WHERE {
        GRAPH ${iri(GRAPHS.current)} { ${iri(work)} rv:head ?head } }`)).results?.bindings[0]?.head?.value;
      if (!head) throw new Error('Work head is unavailable');
      return head;
    };
    const recordType = async (work: string, types: string[]) => {
      await manager.grant(`work:edit:${work}`, 'work.edit');
      await json(await manager.send('PUT', `/v1/works/${work.slice(-36)}/type`, {
        profile: 'work-type-v2', expectedHead: await workHead(work), types, actingSubject: manager.actor,
      }), 200);
    };
    for (const item of [source, candidate, another, sameAuthor, chapter, hidden]) await recordType(item.work, [BOOK]);
    await recordType(unrelated.work, [GUIDE]);
    await recordType(modSource.work, [MOD]);
    await recordType(modCandidate.work, [MOD]);
    // The shelf excludes a shared author identity. A native credit and an Open Library
    // key are the same exclusion once both works name that author.
    const creditAuthor = async (work: string) => {
      await json(await manager.send('POST', `/v1/works/${work.slice(-36)}/agent-credits`, {
        profile: 'native-agent-credit-v1', credit: `https://rezics.com/id/${randomUUID()}`,
        agent: manager.actor, role: 'author', expectedWorkHead: await workHead(work),
        actingSubject: manager.actor,
      }), 201);
    };
    await creditAuthor(source.work);
    await creditAuthor(sameAuthor.work);
    const store = new AlsoEnjoyedStore(stack.accessPool, stack.contentPool);
    const principals = new Map<string, typeof manager.principal>([[manager.token, manager.principal]]);
    const deps = { environment: stack.env, access: stack.access, media: stack.media,
      templateSeek: stack.templateSeek, alsoEnjoyed: store, account: { verify: async (request: Request) => {
        const principal = principals.get(request.headers.get('authorization')?.replace('Bearer ', '') ?? '');
        if (!principal) throw new Error('unknown bearer');
        return principal;
      } } };
    const app = createMainApp(stack.fuseki, deps);
    const read = (limit = 6, cursor?: string) => app.handle(new Request(`http://main.local/v1/works/${source.work.slice(-36)}/also-enjoyed?limit=${limit}${cursor ? `&cursor=${cursor}` : ''}`));
    interface CardPage { items: { id: string; basis: string; title: { value: string };
      rating: null | { mean: number; count: number }; primaryCredits: unknown[] }[];
      nextCursor: string | null; sourcePosition: { dataEpoch: string; sequence: string };
      projectionPosition: { dataEpoch: string; sequence: string } | null; stale: boolean }
    const fallback = await json<CardPage>(await read());
    expect(fallback.items.map(item => item.id)).toContain(candidate.work);
    expect(fallback.items.map(item => item.id)).toContain(another.work);
    expect(fallback.items.find(item => item.id === candidate.work)?.basis).toBe('similar');
    expect(fallback.items.map(item => item.id)).not.toContain(source.work);
    expect(fallback.items.map(item => item.id)).not.toContain(hidden.work);
    expect(fallback.items.map(item => item.id)).toContain(chapter.work);
    expect(fallback.items.map(item => item.id)).not.toContain(unrelated.work);
    expect(fallback.items.map(item => item.id)).not.toContain(sameAuthor.work);
    const mods = await json<CardPage>(await app.handle(new Request(
      `http://main.local/v1/works/${modSource.work.slice(-36)}/also-enjoyed?limit=6`)));
    expect(mods.items.map(item => item.id)).toContain(modCandidate.work);
    expect(mods.items.map(item => item.id)).not.toContain(candidate.work);
    expect(mods.items.every(item => item.basis === 'similar')).toBe(true);
    const originalQuery = stack.fuseki.query.bind(stack.fuseki);
    let churn = 0;
    stack.fuseki.query = async (sparql, bytes) => {
      const result = await originalQuery(sparql, bytes);
      if (!stack.fuseki.isBackgroundContext && sparql.includes('SELECT ?epoch ?sequence WHERE')) {
        const index = ++churn;
        await fusekiReadBudget.exit(() => stack.privateWork(manager.actor, `Concurrent private Work ${index}`));
      }
      return result;
    };
    try {
      const started = performance.now();
      const moving = await json<CardPage>(await read(20));
      expect(performance.now() - started).toBeLessThan(WORK_READ_COST.deadlineMs);
      // The recommendation read and its adoption-template read each sample the
      // graph position at the start and again at the end.
      expect(churn).toBe(4);
      expect(moving.stale).toBe(true);
      expect(moving.items.map(item => item.id)).toContain(candidate.work);
      expect(moving.items.map(item => item.id)).not.toContain(hidden.work);
      expect(moving.items.map(item => item.id)).toContain(chapter.work);
      expect(moving.items.map(item => item.id)).not.toContain(sameAuthor.work);
    } finally { stack.fuseki.query = originalQuery; }
    // The candidate stays visible until a later read erases its published Content.
    // That read is after the co-reader assertions, which still need the Work.
    const readers = await Promise.all(['reader-1', 'reader-2', 'reader-3', 'reader-4', 'private-reader']
      .map(name => stack.member(name)));
    for (const [index, reader] of readers.entries()) {
      const representation = (await stack.accessPool.query<{ id: string }>(`
        SELECT id::text FROM access.representation WHERE principal_id = $1 AND subject_id = $2
          LIMIT 1`, [reader.principalId, reader.actor])).rows[0]!.id;
      await stack.accessPool.query(`INSERT INTO access.agent_provision
        (id, principal_id, idempotency_key, request_digest, agent_id, agent_kind,
          display_name, principal_epoch, state, graph_data_epoch, graph_sequence, representation_id)
        VALUES ($1,$2,$3,$4,$5,'person',$6,0,'active',$7,0,$8)`,
      [randomUUID(), reader.principalId, `also-${randomUUID()}`, 'a'.repeat(64), reader.actor,
        reader.name, stack.env.lineage.dataEpoch, representation]);
      if (index < 4) await stack.accessPool.query(`INSERT INTO access.agent_library_visibility
        (agent_id, visibility, version) VALUES ($1,'public',1)`, [reader.actor]);
      if (index !== 3) await stack.contentPool.query(`INSERT INTO reader.library_status
        (agent, work, status, version) VALUES ($1,$2,$3,1)`,
      [reader.actor, source.work, index === 2 ? 'reading' : 'read']);
      if (index < 2 || index === 4) await stack.contentPool.query(`INSERT INTO reader.library_status
        (agent, work, status, version) VALUES ($1,$2,'read',1)`, [reader.actor, candidate.work]);
      if (index < 3) await stack.contentPool.query(`INSERT INTO reader.library_status
        (agent, work, status, version) VALUES ($1,$2,'read',1)`, [reader.actor, unrelated.work]);
    }
    await manager.grant(GLOBAL_CONTEXT_SCOPE, 'rating.context.create');
    const global = await json<{ context: string }>(await manager.send('POST', '/v1/global-rating-contexts',
      { profile: 'global-rating-standing-context-v1', question: 'How good is this book?',
        actingSubject: manager.actor }), 201);
    const ratingReader = readers[3]!;
    await ratingReader.grant(`rating:observe:${global.context}`, 'rating.observation.set');
    for (const [work, mainVersion, value] of [[source.work, source.mainVersion, 5],
      [candidate.work, candidate.mainVersion, 4]] as const) {
      await json(await ratingReader.send('POST', '/v1/global-rating-observations',
        { profile: 'global-rating-standing-observation-v1', context: global.context,
          work, mainVersion, value, expectedRevisionHead: null,
          actingSubject: ratingReader.actor }), 201);
    }
    const current = await json<CardPage>(await read());
    const context = { principal: manager.principal, actingSubject: manager.actor };
    const receipt = () => ({ idempotencyKey: randomUUID(),
      requestDigest: 'b'.repeat(64) });
    await expect(store.register({ principal: readers[0]!.principal,
      actingSubject: readers[0]!.actor }, current.sourcePosition, receipt())).rejects.toThrow();
    const buildReceipt = receipt();
    const { generation } = await store.register(context, current.sourcePosition, buildReceipt)
      .catch(error => { throw new Error('register failed', { cause: error }); });
    expect(await store.register(context, current.sourcePosition, buildReceipt))
      .toEqual({ generation, replayed: true });
    const buildRequest = new Request('http://main.local/v1/also-enjoyed/generations/advance', { method: 'POST' });
    let advances = 0;
    while ((await store.generation(generation)).phase !== 'complete') {
      await store.advance(generation, context, deps, buildRequest)
        .catch(error => { throw new Error('advance failed', { cause: error }); });
      expect(++advances).toBeLessThan(20);
    }
    expect(advances).toBeLessThanOrEqual(2 + Math.ceil(10 / ALSO_ENJOYED_COST.shelfRows) + 3);
    await store.activate(context, generation, null, receipt(), current.sourcePosition)
      .catch(error => { throw new Error('activate failed', { cause: error }); });
    const signals = await store.candidates(source.work);
    expect(signals.sourceReaders).toBe(4);
    expect(signals.candidates.find(item => item.work === candidate.work)?.sharedReaders).toBe(3);
    expect(signals.candidates.find(item => item.work === unrelated.work)?.sharedReaders).toBe(3);
    const page = await json<CardPage>(await read());
    expect(page.stale).toBe(false);
    expect(page.projectionPosition).toEqual(current.sourcePosition);
    expect(page.items.find(item => item.id === candidate.work)?.basis).toBe('co-readers');
    expect(page.items.find(item => item.id === candidate.work)?.title.value).toBe('A co-read book');
    expect(page.items.find(item => item.id === candidate.work)?.rating?.count).toBe(1);
    expect(page.items.map(item => item.id)).not.toContain(hidden.work);
    expect(page.items.map(item => item.id)).not.toContain(unrelated.work);
    const beforeQueries = stack.fuseki.queries;
    const first = await json<CardPage>(await read(1));
    expect(stack.fuseki.queries - beforeQueries).toBeLessThanOrEqual(80);
    expect(first.items.map(item => item.id)).toEqual([candidate.work]);
    expect(first.nextCursor).not.toBeNull();
    expect(() => decodeReadCursor(first.nextCursor!,
      ['also-enjoyed-v1', source.work, null, null], first.sourcePosition)).not.toThrow();
    const second = await json<CardPage>(await read(1, first.nextCursor!));
    expect(second.items.map(item => item.id)).toEqual([another.work]);
    expect(second.items[0]?.basis).toBe('similar');
    expect((await read(1, `${first.nextCursor}broken`)).status).toBe(400);
    const staleBuild = await store.register(context, current.sourcePosition, receipt());
    await stack.accessPool.query(`UPDATE access.agent_library_visibility SET visibility = 'private',
      version = version + 1 WHERE agent_id = $1`, [readers[0]!.actor]);
    // The build completes against its basis and may activate; the revocation
    // after that basis still withholds every co-reader it derived.
    while ((await store.generation(staleBuild.generation)).phase !== 'complete') {
      await store.advance(staleBuild.generation, context, deps, buildRequest);
    }
    expect((await store.activate(context, staleBuild.generation, '1', receipt(), current.sourcePosition))
      .outcome).toBe('succeeded');
    const stale = await json<CardPage>(await read());
    expect(stale.stale).toBe(true);
    expect(stale.items.find(item => item.id === candidate.work)?.basis).toBe('similar');
    expect((await store.candidates(source.work)).sourceReaders).toBe(0);
    const variantId = `urn:rezics:variant:${randomUUID()}`;
    await manager.grant(`work:read:${candidate.work}`, 'work.read');
    await manager.grant(`content:draft:${candidate.work}`, 'content.draft');
    await manager.grant(`content:publish:${candidate.work}`, 'content.publish');
    const saved = await json<{ revisionId: string; sourcePosition: { dataEpoch: string } }>(
      await manager.send('POST', '/v1/content-drafts', {
        profile: 'content-text-v1', resourceId: candidate.work, variantId,
        language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr', expectedHead: null,
        body: `Published body ${randomUUID()}`, actingSubject: manager.actor,
      }), 201);
    const exact = (await stack.content.readExactBatch([saved.revisionId], async ids => new Set(ids)))[0];
    if (exact?.status !== 'available') throw new Error('Content draft was not saved');
    await json(await manager.send('POST', '/v1/content-publications', {
      profile: 'content-publication-v1', preparationId: `also-${randomUUID()}`, revisionId: saved.revisionId,
      expectedDigest: exact.reference.byteDigest, expectedContentEpoch: saved.sourcePosition.dataEpoch,
      resourceId: candidate.work, variantId, expectedPublicationHead: null, actingSubject: manager.actor,
    }), 201);
    await manager.grant(`erasure:${candidate.work}`, 'erasure.request');
    let erasing = false;
    let erasure: { erasureEpoch: string; suppression: string } | undefined;
    stack.fuseki.query = async (sparql, bytes) => {
      const result = await originalQuery(sparql, bytes);
      if (!stack.fuseki.isBackgroundContext && !erasure && !erasing
        && sparql.includes('SELECT ?work ?head ?main ?type WHERE')) {
        erasing = true;
        erasure = await fusekiReadBudget.exit(async () => json(await manager.send('POST', '/v1/erasures', {
          profile: 'content-revision-erasure-v1', actingSubject: manager.actor,
          resourceId: candidate.work, revisionIds: [saved.revisionId],
        }), 200));
      }
      return result;
    };
    try {
      const revoked = await json<CardPage>(await read());
      expect(erasure?.suppression).toBe('suppressed');
      expect(erasure?.erasureEpoch).toMatch(/^[1-9][0-9]*$/);
      expect(revoked.stale).toBe(true);
      expect(revoked.items.map(item => item.id)).not.toContain(candidate.work);
    } finally { stack.fuseki.query = originalQuery; }
  } finally { await stack.stop(); }
}, 240_000);
