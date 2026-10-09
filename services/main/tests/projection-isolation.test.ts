import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { startPostgresCluster } from '../../../tests/qa/support/postgres-cluster.ts';
import { schemaFiles } from '../../../scripts/qa/schema-files.ts';
import { profileRegistry } from '../../../packages/model/src/generated/profiles.ts';
import { ContentCore, ContentUnavailable, type ProjectionPublication, type VariantIdentity } from '../../content/src/core.ts';
import { ContentProjectionCursor } from '../../content/src/projection-cursor.ts';
import { migrateContent } from '../../content/src/migrate.ts';
import { relayContentProjectionOnce } from '../src/modules/content-publication/relay.ts';
import { ReadRankingProjection, RankingProjectionUnavailable } from '../src/modules/rankings/projection.ts';
import { FusekiClient, type SparqlResult } from '../src/infrastructure/fuseki.ts';
import { RV, type WorkActivationEnvironment } from '../src/modules/work/activate.ts';

const root = resolve(import.meta.dir, '../../..');
const id = () => `https://rezics.com/id/${crypto.randomUUID()}`;
const binding = (value: string) => ({ type: 'literal', value });
const graphEpoch = '11111111-1111-4111-8111-111111111111';

/** Graph faults are injected at the owner boundary; durability uses real PostgreSQL. */
class ProjectionGraph extends FusekiClient {
  publications: ProjectionPublication[] = [];
  heads = new Map<string, string>();
  failed = new Set<string>();
  commands = new Set<string>();
  attempts = 0;
  structures = new Map<string, string>();
  constructor() { super('http://localhost:1/rezics'); }
  override async commandHealth() {
    return { moduleVersion: 'test', instanceId: graphEpoch, publicSearchWriteEpoch: '0',
      publicSearchWriteActive: false, profiles: Object.fromEntries(Object.entries(profileRegistry).map(([name, p]) => [name, p.sha256])) };
  }
  override async query(sparql: string): Promise<SparqlResult> {
    if (sparql.includes('SELECT ?work WHERE')) {
      const entry = [...this.structures].find(([structure]) => sparql.includes(`<${structure}>`));
      return { results: { bindings: entry && !this.failed.has(entry[0]) ? [{ work: binding(entry[1]) }] : [] } };
    }
    if (sparql.includes('SELECT DISTINCT ?work ?main')) return { results: { bindings: [] } };
    const publication = this.publications.find(p => sparql.includes(`<${p.graph.receipt}>`));
    if (!publication) throw new Error('unexpected graph proof');
    if (this.failed.has(publication.reference.variantId)) throw new Error('target unavailable');
    const { reference: r, preparationPosition: at, preparationId } = publication;
    const decision = `urn:rezics:decision:${preparationId}`;
    return { results: { bindings: [{ epoch: binding(graphEpoch), routing: binding('1'), sequence: binding('100'),
      outcome: binding(`${RV}Succeeded`), receiptEpoch: binding(graphEpoch), receiptSequence: binding(publication.graph.sequence),
      decision: binding(decision), head: binding(this.heads.get(r.variantId) ?? decision),
      eligibility: binding(`urn:rezics:eligibility:${preparationId}`), eligibleDecision: binding(decision),
      revision: binding(`urn:rezics:content:revision:${r.revisionId}`), digest: binding(r.byteDigest),
      ownerEpoch: binding(at.dataEpoch), ownerSequence: binding(at.sequence), resource: binding(r.resourceId), variant: binding(r.variantId),
      decisionRevision: binding(`urn:rezics:content:revision:${r.revisionId}`), decisionDigest: binding(r.byteDigest),
      decisionEpoch: binding(at.dataEpoch), decisionSequence: binding(at.sequence),
    }] } };
  }
  override async command(command: Parameters<FusekiClient['command']>[0]) {
    this.attempts++;
    this.commands.add(command.receipt);
    return { status: 'committed' as const, receipt: command.receipt, replayed: false,
      position: { datasetId: 'urn:rezics:dataset:product', dataEpoch: graphEpoch, sequence: '100' } };
  }
}

async function postgres(run: (pool: Pool) => Promise<void>) {
  const cluster = await startPostgresCluster();
  const pool = new Pool({ ...cluster.connection, max: 4 });
  try { await migrateContent(pool); await run(pool); }
  finally { await pool.end(); cluster.remove(); }
}

test('Content retains failed A while B projects, survives restart, supersedes in order and replays a graph commit', async () => {
  await postgres(async pool => {
    const content = new ContentCore(pool), graph = new ProjectionGraph();
    const env: WorkActivationEnvironment = { fuseki: graph, lineage: { dataEpoch: graphEpoch, routingEpoch: '1' }, objectDirectory: '.temp/unused' };
    const cursor = new ContentProjectionCursor(pool), consumer = 'isolation';
    await cursor.initialize(consumer);
    const publish = async (variant: VariantIdentity, body: string, predecessor: string | null = null, model = 'content-shape-v1') => {
      const saved = await content.saveDraft({ operationId: crypto.randomUUID(), variant, model, expectedHead: predecessor,
        sourceRevision: null, provenance: {}, serializedJson: JSON.stringify({ body }) });
      const exact = (await content.readExactBatch([saved.revisionId!], async ids => new Set(ids)))[0];
      if (exact?.status !== 'available') throw new Error('source missing');
      const preparationId = crypto.randomUUID();
      await content.preparePublication(preparationId, saved.revisionId!, exact.reference.byteDigest, true, saved.position.dataEpoch);
      const settled = await content.settlePublication(crypto.randomUUID(), preparationId, { outcome: 'active', revisionId: saved.revisionId!,
        receipt: `urn:rezics:receipt:${preparationId}`, dataEpoch: graphEpoch, sequence: '7' }, saved.position.dataEpoch);
      if (!settled.position) throw new Error('terminal source missing');
      const event = (await content.readOutbox(saved.position.dataEpoch, String(BigInt(settled.position.sequence) - 1n), 1))[0]!;
      const publication = await content.readProjectionPublication(event);
      graph.publications.push(publication); graph.heads.set(variant.id, `urn:rezics:decision:${preparationId}`);
      return { revision: saved.revisionId!, event };
    };
    const variant = (language = 'en'): VariantIdentity => ({ id: `urn:rezics:variant:${crypto.randomUUID()}`, resourceId: id(),
      language: { kind: 'tag', tag: language, originalTag: language }, direction: 'ltr' });
    const a = variant('zh-Hans-u-nu-hanidec'), b = variant();
    const first = await publish(a, '中'.repeat(30_000));
    graph.failed.add(a.id);
    await publish(b, '... !!!');
    const later = await publish(a, '后来', first.revision);
    for (let n = 0; n < 9; n++) await relayContentProjectionOnce(env, content, cursor, consumer);
    expect(graph.commands.size).toBe(1);
    expect((await cursor.readScan(consumer)).sequence).toBe('9');
    expect((await cursor.read(consumer)).sequence).toBe('2');
    expect(await pool.query('DELETE FROM content.outbox WHERE id=$1', [first.event.id]).then(() => false, () => true)).toBe(true);
    const restarted = new ContentProjectionCursor(pool);
    expect(await restarted.retries(consumer)).toHaveLength(1);
    graph.failed.clear();
    const unavailableOldBody = Object.create(content) as ContentCore;
    unavailableOldBody.readProjectionPublication = async (event, metadataOnly) => {
      if (event.id === first.event.id && !metadataOnly) throw new ContentUnavailable('old body unavailable');
      return content.readProjectionPublication(event, metadataOnly);
    };
    expect((await relayContentProjectionOnce(env, unavailableOldBody, restarted, consumer))?.disposition).toBe('superseded');
    expect((await relayContentProjectionOnce(env, content, restarted, consumer))?.disposition).toBe('projected');
    expect((await restarted.read(consumer)).sequence).toBe('9');
    expect(graph.commands.size).toBe(2);
    expect(later.event.position.sequence).toBe('9');

    // A crash after graph commit leaves the source unacknowledged. Restart
    // executes the same receipt and never creates another graph effect.
    await publish(b, 'new body', graph.publications.find(p => p.reference.variantId === b.id)!.reference.revisionId);
    await relayContentProjectionOnce(env, content, restarted, consumer);
    await relayContentProjectionOnce(env, content, restarted, consumer);
    await pool.query(`CREATE FUNCTION content.fail_projection_ack() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'crash before acknowledgement'; END $$;
      CREATE TRIGGER fail_projection_ack BEFORE UPDATE ON content.projection_checkpoint
      FOR EACH ROW EXECUTE FUNCTION content.fail_projection_ack()`);
    await expect(relayContentProjectionOnce(env, content, restarted, consumer)).rejects.toThrow('crash before acknowledgement');
    expect((await restarted.readScan(consumer)).sequence).toBe('11');
    const effects = graph.commands.size;
    await pool.query('DROP TRIGGER fail_projection_ack ON content.projection_checkpoint');
    await relayContentProjectionOnce(env, content, new ContentProjectionCursor(pool), consumer);
    expect(graph.commands.size).toBe(effects);
    expect((await restarted.read(consumer)).sequence).toBe('12');

    const organization = variant();
    await publish(organization, 'Organization description', null, 'catalog-description-v1');
    for (let n = 0; n < 3; n++) await relayContentProjectionOnce(env, content, restarted, consumer);
    expect(graph.commands.size).toBe(effects);
    expect((await restarted.read(consumer)).sequence).toBe('15');
    const unknown = await content.saveDraft({ operationId: crypto.randomUUID(), variant: variant(), expectedHead: null,
      model: 'content-shape-v1', sourceRevision: null, provenance: {}, serializedJson: '{"body":"valid"}' });
    const event = (await content.readOutbox(unknown.position.dataEpoch, '15', 1))[0]!;
    const corrupt = Object.create(content) as ContentCore;
    corrupt.readOutbox = async () => [{ ...event, eventType: 'malformed' }];
    await expect(relayContentProjectionOnce(env, corrupt, restarted, consumer)).rejects.toThrow('unrecognized Content event');
    expect((await restarted.readScan(consumer)).sequence).toBe('15');
  });
}, 60_000);

test('Read ranking upgrades populated coverage and retains each failed Structure independently', async () => {
  await postgres(async pool => {
    const files = schemaFiles(root, 'access');
    const upgrade = files.indexOf('1399_read_rankings.sql');
    expect(upgrade).toBeGreaterThanOrEqual(0);
    // Seed the retained row before the upgrade; later migrations also stay in file order.
    for (const file of files.slice(0, upgrade)) {
      await pool.query(readFileSync(join(root, 'services/main/migrations/access', file), 'utf8'));
    }
    const content = new ContentCore(pool), graph = new ProjectionGraph();
    const owner = await content.ownerPosition();
    await pool.query(`INSERT INTO access.read_ranking_checkpoint
      (generation,content_epoch,content_sequence,graph_epoch,review_position) VALUES ($1,$2,7,$3,5)`,
    [crypto.randomUUID(), owner.dataEpoch, graphEpoch]);
    for (const file of files.slice(upgrade)) {
      await pool.query(readFileSync(join(root, 'services/main/migrations/access', file), 'utf8'));
    }
    expect((await pool.query('SELECT content_scan_sequence::text,review_scan_position::text FROM access.read_ranking_checkpoint')).rows[0])
      .toEqual({ content_scan_sequence: '7', review_scan_position: '5' });
    await pool.query('DELETE FROM access.read_ranking_checkpoint');
    const env: WorkActivationEnvironment = { fuseki: graph, lineage: { dataEpoch: graphEpoch, routingEpoch: '1' }, objectDirectory: '.temp/unused' };
    const a = id(), b = id(), aw = id(), bw = id();
    graph.structures.set(a, aw); graph.structures.set(b, bw); graph.failed.add(a);
    const progress = async (structure: string, malformed = false) => {
      const operation = crypto.randomUUID(), occurrence = id(), eventId = crypto.randomUUID();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`INSERT INTO structure.progress_command (principal_issuer,principal_subject,idempotency_key,
          request_digest,structure,occurrence,selection_key,result_version,result_completed,content_operation,first_read,first_finish)
          VALUES ('test','test',$1,$2,$3,$4,'',1,false,$1,true,false)`, [operation, 'a'.repeat(64), structure, occurrence]);
        await client.query(`INSERT INTO content.receipt(operation_id,request_digest,action,outcome)
          VALUES ($1,$2,'structure.progress','succeeded')`, [operation, 'a'.repeat(64)]);
        await client.query(`INSERT INTO content.outbox(id,operation_id,event_type,recipe,payload)
          VALUES ($1,$2,'structure.progress.written','structure-progress-v1',$3::jsonb)`,
        [eventId, operation, JSON.stringify({ structure, occurrence, read: !malformed, finished: false })]);
        await client.query('COMMIT');
      } finally { client.release(); }
      await content.sequencePending();
    };
    await progress(a); await progress(b); await progress(a);
    const projection = new ReadRankingProjection(pool, content, pool, env);
    expect(await projection.tick()).toBe(3);
    const checkpoint = (await pool.query('SELECT content_scan_sequence::text,content_sequence::text FROM access.read_ranking_checkpoint')).rows[0];
    expect(checkpoint).toEqual({ content_scan_sequence: '3', content_sequence: '0' });
    expect((await pool.query("SELECT work,score::text FROM access.read_ranking_score WHERE metric='reads' AND interval='day'")).rows)
      .toEqual([{ work: bw, score: '1' }]);
    await expect(projection.current()).rejects.toThrow('catching up');
    const restarted = new ReadRankingProjection(pool, content, pool, env);
    graph.failed.clear();
    const concurrent = await Promise.allSettled([restarted.tick(), new ReadRankingProjection(pool, content, pool, env).tick()]);
    expect(concurrent.some(result => result.status === 'fulfilled')).toBe(true);
    for (const result of concurrent) if (result.status === 'rejected') expect(result.reason).toBeInstanceOf(RankingProjectionUnavailable);
    const remaining = (await pool.query(`SELECT first_position::text FROM access.read_ranking_target WHERE target=$1`, [a])).rows;
    expect(remaining.every(row => row.first_position === '3')).toBe(true);
    expect(await restarted.tick()).toBeLessThanOrEqual(1);
    expect(await restarted.tick()).toBe(0);
    expect((await restarted.current()).contentSequence).toBe('3');
    expect((await pool.query("SELECT score::text FROM access.read_ranking_score WHERE work=$1 AND metric='reads' AND interval='day'", [aw])).rows[0].score).toBe('2');
    await progress(b);
    await pool.query(`CREATE FUNCTION access.fail_ranking_ack() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'crash before ranking acknowledgement'; END $$;
      CREATE TRIGGER fail_ranking_ack BEFORE UPDATE ON access.read_ranking_checkpoint
      FOR EACH ROW EXECUTE FUNCTION access.fail_ranking_ack()`);
    await expect(restarted.tick()).rejects.toThrow('crash before ranking acknowledgement');
    expect((await pool.query("SELECT score::text FROM access.read_ranking_score WHERE work=$1 AND metric='reads' AND interval='day'", [bw])).rows[0].score).toBe('1');
    await pool.query('DROP TRIGGER fail_ranking_ack ON access.read_ranking_checkpoint');
    await new ReadRankingProjection(pool, content, pool, env).tick();
    expect((await pool.query("SELECT score::text FROM access.read_ranking_score WHERE work=$1 AND metric='reads' AND interval='day'", [bw])).rows[0].score).toBe('2');
    await progress(b, true);
    await expect(restarted.tick()).rejects.toThrow('differs from its receipt');
    expect((await pool.query('SELECT content_scan_sequence::text FROM access.read_ranking_checkpoint')).rows[0].content_scan_sequence).toBe('4');
    await pool.query('UPDATE access.read_ranking_checkpoint SET content_sequence=3 WHERE singleton');
    await expect(restarted.current()).rejects.toThrow('catching up');
    await expect(restarted.tick()).rejects.toThrow('coverage differs');
  });
}, 60_000);

test('Content retries seek at most eight target heads even with a long same-target backlog', async () => {
  await postgres(async pool => {
    const content = new ContentCore(pool), cursor = new ContentProjectionCursor(pool);
    const consumer = 'bounded-retries';
    let position = await cursor.initialize(consumer), revision: string | null = null;
    const variant: VariantIdentity = { id: `urn:rezics:variant:${crypto.randomUUID()}`, resourceId: id(),
      language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr' };
    for (let index = 1; index <= 100; index++) {
      const saved = await content.saveDraft({ operationId: crypto.randomUUID(), variant,
        expectedHead: revision, model: 'content-shape-v1', sourceRevision: null, provenance: {},
        serializedJson: JSON.stringify({ body: `Retained event ${index}` }) });
      revision = saved.revisionId;
      const event = (await content.readOutbox(position.dataEpoch, position.sequence, 1))[0]!;
      const retained = { event, target: index <= 9 ? `target:${index}` : 'target:1' };
      if (index === 100) {
        const attempts = await Promise.allSettled([cursor.acknowledge(consumer, position, event.position, retained),
          new ContentProjectionCursor(pool).acknowledge(consumer, position, event.position, retained)]);
        expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      } else await cursor.acknowledge(consumer, position, event.position, retained);
      position = event.position;
    }
    const first = await cursor.retries(consumer);
    expect(first).toHaveLength(8);
    expect(first.map(event => event.position.sequence)).toEqual(['1','2','3','4','5','6','7','8']);
    for (const event of first) await cursor.finishRetry(consumer, event, false);
    expect((await cursor.retries(consumer))[0]?.position.sequence).toBe('9');
    await cursor.finishRetry(consumer, first[0]!, true);
    expect((await pool.query(`SELECT first_sequence::text FROM content.projection_target
      WHERE consumer=$1 AND target='target:1'`, [consumer])).rows[0].first_sequence).toBe('10');
    expect((await cursor.read(consumer)).sequence).toBe('1');
    expect((await cursor.readScan(consumer)).sequence).toBe('100');
    await expect(cursor.acknowledge(consumer, position, { ...position, sequence: '101' })).rejects.toThrow('source event missing');
    expect((await cursor.readScan(consumer)).sequence).toBe('100');
    await pool.query('DELETE FROM content.projection_pending WHERE consumer=$1', [consumer]);
    await expect(cursor.readScan(consumer)).rejects.toThrow('coverage differs');
    await expect(cursor.acknowledge(consumer, position, { ...position, sequence: '101' })).rejects.toThrow('coverage differs');
  });
}, 60_000);


test('Fresh Access install applies every migration in file order and enforces ranking coverage', async () => {
  await postgres(async pool => {
    for (const file of schemaFiles(root, 'access')) {
      await pool.query(readFileSync(join(root, 'services/main/migrations/access', file), 'utf8'));
    }
    const owner = await new ContentCore(pool).ownerPosition();
    await pool.query(`INSERT INTO access.read_ranking_checkpoint
      (generation,content_epoch,graph_epoch) VALUES ($1,$2,$3)`,
    [crypto.randomUUID(), owner.dataEpoch, graphEpoch]);
    expect((await pool.query(`SELECT content_sequence::text,content_scan_sequence::text,
      review_position::text,review_scan_position::text FROM access.read_ranking_checkpoint`)).rows[0])
      .toEqual({ content_sequence: '0', content_scan_sequence: '0', review_position: '0', review_scan_position: '0' });
    await expect(pool.query('UPDATE access.read_ranking_checkpoint SET content_sequence=1 WHERE singleton'))
      .rejects.toMatchObject({ code: '23514' });
    await expect(pool.query('UPDATE access.read_ranking_checkpoint SET review_position=1 WHERE singleton'))
      .rejects.toMatchObject({ code: '23514' });
    await pool.query(`UPDATE access.read_ranking_checkpoint SET content_sequence=1,content_scan_sequence=1,
      review_position=1,review_scan_position=1 WHERE singleton`);
  });
}, 60_000);
