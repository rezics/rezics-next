import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { ContentCore, ContentProjectionCursor, ContentUnavailable,
  migrateContent, type VariantIdentity } from '../../content/src/index.ts';
import { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { ContentProjectionGap, ContentProjectionProfileUnavailable,
  ContentProjectionUnavailable, relayContentProjectionOnce } from
  '../src/modules/content-publication/relay.ts';
import { queryPublicContentPhrase } from '../src/modules/content-publication/search.ts';
import { ContentProjectionWorker } from '../src/content-projection-worker.ts';
import { GRAPHS, RV, iri } from '../src/modules/work/activate.ts';

const root = resolve(import.meta.dir, '../../..');

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('no PostgreSQL test port'));
      server.close(() => resolvePort(address.port));
    });
  });
}

test('SEARCH15/WORK10: partial Content outbox checkpoint and fail-closed MatchUnit relay', async () => {
  const fusekiUrl = process.env.FUSEKI_URL;
  if (!fusekiUrl) throw new Error('FUSEKI_URL must point to an isolated pinned Fuseki stack');
  const fuseki = new FusekiClient(fusekiUrl);
  expect((await fuseki.query('ASK {}')).boolean).toBe(true);
  const state = join(root, '.temp', `content-projection-${crypto.randomUUID()}`);
  const data = join(state, 'pgdata');
  const socket = join(root, '.temp', 'pg-sock');
  mkdirSync(state, { recursive: true, mode: 0o700 });
  mkdirSync(socket, { recursive: true, mode: 0o700 });
  execFileSync('initdb', ['-D', data, '-A', 'trust', '--no-instructions'], { cwd: state });
  const port = await freePort();
  execFileSync('pg_ctl', ['-D', data, '-l', join(state, 'postgres.log'),
    '-o', `-h 127.0.0.1 -p ${port} -k ${socket}`, '-w', 'start'], { cwd: state });
  const pool = new Pool({ host: '127.0.0.1', port, user: process.env.USER, database: 'postgres', max: 6 });
  try {
    await migrateContent(pool);
    await migrateContent(pool);
    const content = new ContentCore(pool);
    const cursor = new ContentProjectionCursor(pool);
    const consumer = 'content-search-test';
    const initial = await cursor.initialize(consumer);
    expect(initial.sequence).toBe('0');
    const variant: VariantIdentity = { id: `urn:rezics:variant:${crypto.randomUUID()}`,
      resourceId: `https://rezics.com/id/${crypto.randomUUID()}`,
      language: { kind: 'tag', tag: 'zh', originalTag: 'zh' }, direction: 'ltr' };
    const saved = await content.saveDraft({ operationId: `draft-${crypto.randomUUID()}`,
      variant, expectedHead: null, model: 'content-shape-v1', sourceRevision: null,
      provenance: { author: 'projection-test' }, serializedJson: '{"body":"中文检索投影"}' });
    if (!saved.revisionId) throw new Error('Content revision was not saved');
    const exact = (await content.readExactBatch([saved.revisionId],
      async ids => new Set(ids)))[0];
    if (exact?.status !== 'available') throw new Error('exact Content bytes unavailable');
    const preparationId = `prepare-${crypto.randomUUID()}`;
    const prepared = await content.preparePublication(preparationId, saved.revisionId,
      exact.reference.byteDigest, true, saved.position.dataEpoch);
    const terminal = await content.settlePublication(`settle-${crypto.randomUUID()}`, preparationId,
      { outcome: 'active', revisionId: saved.revisionId,
        receipt: `urn:rezics:receipt:${crypto.randomUUID()}`,
        dataEpoch: 'unproven-graph-epoch', sequence: '7' }, saved.position.dataEpoch);
    expect(terminal.status).toBe('active');
    const events = await content.readOutbox(initial.dataEpoch, '0', 4);
    expect(events.map(event => event.position.sequence)).toEqual(['1', '2', '3']);
    const source = await content.readProjectionPublication(events[2]!);
    expect(source).toMatchObject({ preparationId, status: 'active',
      preparationPosition: prepared.position,
      reference: { revisionId: saved.revisionId, byteDigest: exact.reference.byteDigest } });
    await expect(content.readProjectionPublication({ ...events[2]!,
      payload: { ...events[2]!.payload, revisionId: crypto.randomUUID() } }))
      .rejects.toBeInstanceOf(ContentUnavailable);
    const environment = { fuseki, lineage: { dataEpoch: 'unproven-graph-epoch', routingEpoch: '1' },
      objectDirectory: join(state, 'objects') };
    const firstWorker = new ContentProjectionWorker(
      () => relayContentProjectionOnce(environment, content, cursor, consumer));
    expect((await firstWorker.pollOnce())?.sourceSequence).toBe('1');
    const restartedCursor = new ContentProjectionCursor(pool);
    expect((await restartedCursor.initialize(consumer)).sequence).toBe('1');
    const restartedWorker = new ContentProjectionWorker(
      () => relayContentProjectionOnce(environment, content, restartedCursor, consumer));
    expect((await restartedWorker.pollOnce())?.sourceSequence).toBe('2');
    expect((await cursor.initialize(consumer)).sequence).toBe('2');
    await expect(queryPublicContentPhrase(environment, content, cursor, consumer,
      { phrase: '中文检索', language: 'zh' })).rejects.toBeInstanceOf(ContentProjectionUnavailable);
    // The graph publication proof is deliberately absent. The relay may not acknowledge
    // this Content terminal event, with or without a later installed native profile.
    let stopped: unknown;
    try { await relayContentProjectionOnce(environment, content, cursor, consumer); }
    catch (error) { stopped = error; }
    expect(stopped instanceof ContentProjectionProfileUnavailable
      || stopped instanceof ContentProjectionUnavailable).toBe(true);
    expect((await cursor.read(consumer)).sequence).toBe('2');
    expect((await fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH ${iri(GRAPHS.current)} {
      ${iri(variant.id)} rv:contentPublicationHead ?decision } }`)).boolean).toBe(false);
    expect((await fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH <urn:rezics:search:public> {
      ?unit a rv:MatchUnit ; rv:variant ${iri(variant.id)} } }`)).boolean).toBe(false);
    await pool.query(`UPDATE content.owner_control SET sequence = sequence + 1 WHERE singleton`);
    await pool.query(`UPDATE content.projection_checkpoint SET sequence = 3 WHERE consumer = $1`, [consumer]);
    await expect(relayContentProjectionOnce(environment, content, cursor, consumer))
      .rejects.toBeInstanceOf(ContentProjectionGap);
    await pool.query(`UPDATE content.owner_control SET data_epoch = gen_random_uuid() WHERE singleton`);
    await expect(cursor.read(consumer)).rejects.toThrow('owner epoch changed');
  } finally {
    await pool.end();
    execFileSync('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop'], { cwd: state });
    rmSync(state, { recursive: true, force: true });
  }
}, 30_000);
