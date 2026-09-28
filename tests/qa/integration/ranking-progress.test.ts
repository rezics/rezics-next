import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { startMediaStack } from './media-support.ts';
import { StructureProgressStore } from '../../../services/main/src/modules/progress/store.ts';
import { readProgressSignal } from '../../../services/main/src/modules/structure/progress-outbox.ts';
import { ReadRankingProjection, rankingBuckets } from '../../../services/main/src/modules/rankings/projection.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { GRAPHS, iri } from '../../../services/main/src/modules/work/activate.ts';
import type { WorkActivationEnvironment } from '../../../services/main/src/modules/work/activate.ts';

const id = () => `https://rezics.com/id/${randomUUID()}`;

test('G291: progress outbox replays once; ranking cursor and scores reset on graph epoch change', async () => {
  const stack = await startMediaStack('ranking-progress');
  try {
    const member = await stack.member('ranking-reader');
    const publicWork = await stack.publicWork(member.actor, ['en'], 'Ranking chapter');
    await member.grant('space:create:root', 'space.create');
    const realmResponse = await member.send('POST', '/v1/spaces', {
      profile: 'space-realm-v1', name: 'Reading Realm', capabilities: ['realm'],
      actingSubject: member.actor });
    expect(realmResponse.status).toBe(201);
    const realm = (await realmResponse.json() as { realm: string }).realm;
    await member.grant(`publication:adopt:${realm}`, 'publication.adopt');
    const adoption = await member.send('POST', '/v1/publication-selections', {
      profile: 'realm-local-selection-v1', context: { kind: 'realm-local', id: realm },
      work: publicWork.work, mainVersion: publicWork.mainVersion,
      contribution: publicWork.variants[0]!.contribution,
      publicationDecision: publicWork.variants[0]!.decision,
      expectedSelectionHead: null, selectionBasis: 'realm-manager-review', actingSubject: member.actor });
    expect(adoption.status).toBe(201);
    const structure = id(), occurrence = id(), work = publicWork.work;
    // Use the graph's real schema:CreativeWork type. A mocked ?work binding
    // masked the projection's former rv:Work lookup, which stalled live replay.
    await stack.fuseki.update(`PREFIX rv: <https://rezics.com/vocab/> INSERT DATA {
      GRAPH ${iri(GRAPHS.current)} { ${iri(structure)} a rv:Structure ;
        rv:structureOf ${iri(publicWork.mainVersion)} . }
    }`);
    const principal = { issuer: 'https://reader.example', subject: randomUUID() };
    const store = new StructureProgressStore(stack.contentPool);
    const env = stack.env;
    const projection = new ReadRankingProjection(stack.accessPool, stack.content,
      stack.contentPool, env);
    for (let i = 0; i < 100 && (await projection.tick()) > 0; i++) { /* bounded catch-up */ }
    const initial = await projection.current();
    const previousDay = rankingBuckets(new Date(), 'day').previous;
    await stack.accessPool.query(`INSERT INTO access.read_ranking_score
      (generation, metric, interval, bucket, work, score, growth)
      VALUES ($1,'reads','day',$2,$3,5,5)`, [initial.generation, previousDay, work]);
    const start = await stack.content.ownerPosition();
    const input = { principal, structure, occurrence, selectedRevision: null,
      completed: false, position: 'paragraph:1', expectedVersion: 0, idempotencyKey: randomUUID() };
    expect(await store.write(input)).toMatchObject({ version: 1, replayed: false });
    expect(await store.write(input)).toMatchObject({ version: 1, replayed: true });
    const finished = await store.write({ ...input, completed: true, expectedVersion: 1,
      idempotencyKey: randomUUID() });
    expect(finished).toMatchObject({ version: 2, completed: true });
    const events = (await stack.content.readOutbox(start.dataEpoch, start.sequence, 10))
      .filter(event => event.recipe === 'structure-progress-v1');
    expect(events).toHaveLength(2);
    expect(await readProgressSignal(stack.contentPool, events[0]!)).toMatchObject({
      structure, occurrence, read: true, finished: false });
    expect(await readProgressSignal(stack.contentPool, events[1]!)).toMatchObject({
      structure, occurrence, read: false, finished: true });
    await expect(readProgressSignal(stack.contentPool, { ...events[0]!,
      payload: { ...events[0]!.payload, read: false } })).rejects.toThrow('differs');

    for (let i = 0; i < 100 && (await projection.tick()) > 0; i++) { /* bounded catch-up */ }
    const first = await projection.current();
    expect(first.generation).toBe(initial.generation);
    const bucket = new Date().toISOString().slice(0, 10);
    const score = await stack.accessPool.query<{ metric: string; score: string }>(
      `SELECT metric, score::text FROM access.read_ranking_score
       WHERE generation = $1 AND bucket = $2 AND interval = 'day' ORDER BY metric`,
      [first.generation, bucket]);
    expect(score.rows).toEqual([{ metric: 'finished-chapters', score: '1' },
      { metric: 'reads', score: '1' }]);
    expect(await projection.tick()).toBe(0);
    expect((await projection.current()).generation).toBe(first.generation);
    const app = createMainApp(stack.fuseki, { environment: stack.env, access: stack.access,
      account: { verify: async () => principal }, readRankings: projection,
      media: stack.media, mediaAccess: stack.mediaAccess });
    const response = await app.handle(new Request('http://main.local/v1/rankings/trending?metric=reads&interval=day'));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ profile: 'read-rankings-v1', realm: null,
      metric: 'reads', interval: 'day', items: [{ id: work, score: 1 }] });
    const realmRanking = await app.handle(new Request(
      `http://main.local/v1/realms/${realm.slice(-36)}/rankings?metric=finished-chapters&interval=day`));
    expect(realmRanking.status).toBe(200);
    expect(await realmRanking.json()).toMatchObject({ realm, metric: 'finished-chapters',
      items: [{ id: work, score: 1 }] });
    const rising = await app.handle(new Request(
      `http://main.local/v1/realms/${realm.slice(-36)}/modules/rising?metric=reads&interval=day`));
    expect(rising.status).toBe(200);
    expect(await rising.json()).toMatchObject({ profile: 'rising-v1', realm,
      items: [] });
    const finishingRise = await app.handle(new Request(
      `http://main.local/v1/realms/${realm.slice(-36)}/modules/rising?metric=finished-chapters&interval=day`));
    expect(finishingRise.status).toBe(200);
    expect(await finishingRise.json()).toMatchObject({ profile: 'rising-v1', realm,
      items: [{ id: work, score: 1, growth: 1 }] });

    const restoredEnv = { ...env, lineage: { ...env.lineage, dataEpoch: randomUUID() },
      fuseki: { query: async () => ({ results: { bindings: [
        { work: { type: 'uri', value: work } },
      ] } }) } } as unknown as WorkActivationEnvironment;
    const restored = new ReadRankingProjection(stack.accessPool, stack.content,
      stack.contentPool, restoredEnv);
    for (let i = 0; i < 100 && (await restored.tick()) > 0; i++) { /* replay into new generation */ }
    const next = await restored.current();
    expect(next.generation).not.toBe(first.generation);
    expect((await stack.accessPool.query(`SELECT score FROM access.read_ranking_score
      WHERE generation = $1 AND bucket = $2 AND interval = 'day'`,
    [next.generation, bucket])).rowCount).toBe(2);

    const concurrentCut = await stack.content.ownerPosition();
    const repeatedOccurrence = id();
    const concurrent = await Promise.allSettled([0, 1].map(() => store.write({
      principal, structure, occurrence: repeatedOccurrence,
      selectedRevision: `urn:rezics:content:revision:${randomUUID()}`,
      completed: true, position: null, expectedVersion: 0, idempotencyKey: randomUUID(),
    })));
    expect(concurrent.filter(result => result.status === 'fulfilled')).toHaveLength(2);
    const simultaneous = (await stack.content.readOutbox(concurrentCut.dataEpoch,
      concurrentCut.sequence, 10)).filter(event => event.recipe === 'structure-progress-v1');
    expect(simultaneous).toHaveLength(2);
    const counted = await Promise.all(simultaneous.map(event => readProgressSignal(stack.contentPool, event)));
    expect(counted.filter(event => event.read)).toHaveLength(1);
    expect(counted.filter(event => event.finished)).toHaveLength(1);
  } finally { await stack.stop(); }
});

test('G385: ten or more review rank changes advance the ranking checkpoint in position order', async () => {
  const stack = await startMediaStack('ranking-reviews');
  try {
    const projection = new ReadRankingProjection(stack.accessPool, stack.content, stack.contentPool, stack.env);
    for (let i = 0; i < 100 && (await projection.tick()) > 0; i++) { /* bounded catch-up */ }
    const work = id();
    // Positions 1–12 in text order would read 1, 10, 11, 12, 2, … and stall the projection as not contiguous.
    for (let i = 0; i < 12; i++) {
      await stack.accessPool.query('SELECT access.append_reader_review_rank_change($1, clock_timestamp(), 1)', [work]);
    }
    for (let i = 0; i < 100 && (await projection.tick()) > 0; i++) { /* bounded catch-up */ }
    const positions = await stack.accessPool.query<{ checkpoint: string; head: string }>(`SELECT
      c.review_position::text AS checkpoint, h.position::text AS head
      FROM access.read_ranking_checkpoint c CROSS JOIN access.reader_review_rank_head h WHERE c.singleton`);
    expect(positions.rows[0]!.checkpoint).toBe(positions.rows[0]!.head);
    expect(await projection.tick()).toBe(0);
  } finally { await stack.stop(); }
});
