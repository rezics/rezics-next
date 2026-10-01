import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { ContentCore } from '../../../services/content/src/core.ts';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { ContentProjectionCursor } from '../../../services/content/src/projection-cursor.ts';
import { createMainApp, type MainWorkDependencies } from '../../../services/main/src/app.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccountAssertionDenied } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { activateMetadataWork, metadataWorkRequestDigest }
  from '../../../services/main/src/modules/work/activate.ts';
import { initializeRelayCheckpoint } from '../../../services/main/src/modules/outbox/relay.ts';
import { RelayHandoffPositions } from '../../../services/main/src/modules/outbox/relay-position.ts';
import { BACKPRESSURE_PROFILE_V1 } from '../../../services/main/src/operations/backpressure.ts';

const root = resolve(import.meta.dir, '../../..');
const consumer = 'main-content-backpressure-v1';
const agent = `https://rezics.com/id/${randomUUID()}`;

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

interface Snapshot {
  profile: string;
  complete: boolean;
  lanes: [{ state: string; backlog: string | null; head: string | null; delivered: string | null },
    { state: string }, { state: string }];
}

test('OPS06: worker and broker saturation refuse new intents and lose no admitted work', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.FUSEKI_URL
    || !Bun.env.MAIN_DATA_EPOCH || !Bun.env.MAIN_ROUTING_EPOCH) {
    throw new Error('Run this test through the isolated QA integration tier');
  }
  const state = join(root, '.temp', `backpressure-${randomUUID()}`);
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
    // Content and relay are separate owners; one disposable server hosts both schemas.
    await migrateContent(pool);
    const relayDir = join(root, 'services/main/migrations/relay');
    for (const file of readdirSync(relayDir).filter(name => name.endsWith('.sql')).sort()) {
      await pool.query(readFileSync(join(relayDir, file), 'utf8'));
    }
    let contentCalls = 0;
    const countedPool = { query: (...args: unknown[]) => {
      contentCalls += 1;
      return (pool.query as (...values: unknown[]) => unknown).apply(pool, args);
    }, connect: () => pool.connect() } as unknown as Pool;
    const content = new ContentCore(pool);
    const cursor = new ContentProjectionCursor(pool);
    const initial = await cursor.initialize(consumer);
    const fuseki = new FusekiClient(Bun.env.FUSEKI_URL);
    const lineage = { dataEpoch: Bun.env.MAIN_DATA_EPOCH, routingEpoch: Bun.env.MAIN_ROUTING_EPOCH };
    let verified = 0;
    const work = {
      environment: { fuseki, lineage, objectDirectory: join(state, 'objects') },
      account: { verify: async () => { verified += 1; throw new AccountAssertionDenied('QA'); } },
      access: {},
      content, contentAuthoring: content,
      contentProjection: { content: new ContentCore(countedPool),
        cursor: new ContentProjectionCursor(countedPool), consumer },
    } as unknown as MainWorkDependencies;
    const app = createMainApp(fuseki, work);
    const read = async () => {
      const response = await app.handle(new Request('http://main.local/v1/operations/backpressure'));
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      return await response.json() as Snapshot;
    };
    const draftRequest = () => app.handle(new Request('http://main.local/v1/content-drafts', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer a.b.c',
        'idempotency-key': `draft-${randomUUID()}` },
      body: JSON.stringify({ profile: 'content-text-v1',
        resourceId: `https://rezics.com/id/${randomUUID()}`,
        variantId: `urn:rezics:variant:${randomUUID()}`,
        language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr',
        expectedHead: null, body: 'backpressure', actingSubject: agent }) }));

    // Real Content commands fill the projection worker's durable backlog.
    const variant = { id: `urn:rezics:variant:${randomUUID()}`, resourceId: `urn:rezics:work:${randomUUID()}`,
      language: { kind: 'tag' as const, tag: 'en', originalTag: 'en' }, direction: 'ltr' as const };
    let head: string | null = null;
    const save = async (index: number) => {
      const saved = await content.saveDraft({ operationId: `backpressure-${randomUUID()}`, variant,
        expectedHead: head, model: 'content-shape-v1', sourceRevision: null, provenance: { qa: 'OPS06' },
        serializedJson: JSON.stringify({ body: `revision ${index}` }) });
      expect(saved.outcome).toBe('succeeded');
      head = saved.revisionId;
    };
    const max = BACKPRESSURE_PROFILE_V1.worker.maxBacklog;
    const scales: { backlog: number; calls: number }[] = [];
    let saved = 0;
    for (const target of [0, 10, 100, max - 1]) {
      while (saved < target) await save(saved++);
      const before = contentCalls;
      const snapshot = await read();
      scales.push({ backlog: target, calls: contentCalls - before });
      expect(snapshot.lanes[0]).toMatchObject({ state: 'open', backlog: String(target),
        delivered: initial.sequence });
    }
    // OPS05: positions, not rows, are read; growth adds no Content statements.
    expect(new Set(scales.map(scale => scale.calls))).toEqual(new Set([2]));
    // Below the budget a Content command passes admission and reaches its owner path.
    const beforeOpen = verified;
    expect((await draftRequest()).status).toBe(401);
    expect(verified).toBe(beforeOpen + 1);

    await save(saved++);
    const saturated = await read();
    expect(saturated.lanes[0]).toMatchObject({ state: 'saturated', backlog: String(max) });
    const ownerBefore = await content.ownerPosition();
    const refused = await draftRequest();
    expect(refused.status).toBe(503);
    expect(refused.headers.get('retry-after')).toBe(String(BACKPRESSURE_PROFILE_V1.worker.retryAfterSeconds));
    expect((await refused.json() as { code: string }).code).toBe('backpressure_saturated');
    // Refusal precedes Account, Access and Content: no owner effect was made.
    expect(verified).toBe(beforeOpen + 1);
    expect(await content.ownerPosition()).toEqual(ownerBefore);
    // The broker lane has no relay source in this Main process and says so.
    expect(saturated.lanes[1].state).toBe('unobserved');
    expect(saturated.complete).toBe(false);

    // The consumer drains by acknowledging exact events; admission reopens only
    // after the backlog falls below the budget, and every event is retained.
    let delivered = initial;
    for (let index = 0; index < 5; index++) {
      const [event] = await content.readOutbox(delivered.dataEpoch, delivered.sequence, 1);
      await cursor.acknowledge(consumer, delivered, event!.position);
      delivered = event!.position;
    }
    const drained = await read();
    expect(drained.lanes[0]).toMatchObject({ state: 'open', backlog: String(max - 5),
      delivered: delivered.sequence });
    expect((await draftRequest()).status).toBe(401);
    const retained = await pool.query<{ count: string; first: string; last: string }>(`
      SELECT count(*)::text AS count, min(sequence)::text AS first, max(sequence)::text AS last
      FROM content.outbox WHERE data_epoch = $1`, [initial.dataEpoch]);
    expect(retained.rows[0]).toEqual({ count: String(max), first: '1', last: String(max) });

    // A foreign Content epoch makes the lane unprovable, so admission fails closed.
    const checkpointEpoch = initial.dataEpoch;
    await pool.query('ALTER TABLE content.projection_checkpoint DISABLE TRIGGER USER');
    await pool.query('UPDATE content.projection_checkpoint SET data_epoch = $2 WHERE consumer = $1',
      [consumer, randomUUID()]);
    const unprovable = await draftRequest();
    expect(unprovable.status).toBe(503);
    expect((await unprovable.json() as { code: string }).code).toBe('backpressure_unavailable');
    expect((await read()).lanes[0].state).toBe('unavailable');
    await pool.query('UPDATE content.projection_checkpoint SET data_epoch = $2 WHERE consumer = $1',
      [consumer, checkpointEpoch]);
    await pool.query('ALTER TABLE content.projection_checkpoint ENABLE TRIGGER USER');
    expect((await read()).lanes[0].state).toBe('open');

    // Broker: a real graph command advances Main's outbox high water; the relay
    // checkpoint in its own schema decides the lane.
    const admissionId = randomUUID();
    const title = `Backpressure ${randomUUID()}`;
    await activateMetadataWork({ fuseki, lineage, objectDirectory: join(state, 'objects') }, { title,
      admission: { id: admissionId, scope: 'work:create:root', action: 'work.create',
        idempotencyKey: `backpressure-${admissionId}`, requestDigest: metadataWorkRequestDigest(title),
        authorityEpoch: '0', expiresAt: new Date(Date.now() + 60_000).toISOString() } });
    const relayConsumer = `backpressure-${randomUUID()}`;
    await initializeRelayCheckpoint(pool, relayConsumer, lineage.dataEpoch);
    // Main observes the relay checkpoint only through a read-only session.
    const relayReader = new Pool({ host: '127.0.0.1', port, user: process.env.USER, database: 'postgres',
      max: 2, options: '-c default_transaction_read_only=on' });
    try {
      await expect(relayReader.query('UPDATE relay.checkpoint SET sequence = 0 WHERE consumer = $1',
        [relayConsumer])).rejects.toMatchObject({ code: '25006' });
      const brokerProfile = { ...BACKPRESSURE_PROFILE_V1, id: 'operations-backpressure-qa-v1',
        broker: { maxBacklog: 1, retryAfterSeconds: 3 } };
      let brokerVerified = 0;
      const brokerApp = createMainApp(fuseki, { ...work,
        account: { verify: async () => { brokerVerified += 1; throw new AccountAssertionDenied('QA'); } },
        relayPosition: new RelayHandoffPositions(relayReader, relayConsumer),
        backpressureProfile: brokerProfile } as MainWorkDependencies);
      const brokerSnapshot = async () => {
        const response = await brokerApp.handle(new Request('http://main.local/v1/operations/backpressure'));
        expect(response.status).toBe(200);
        return await response.json() as { profile: string; complete: boolean;
          lanes: [unknown, { state: string; head: string | null; delivered: string | null;
            backlog: string | null }, unknown] };
      };
      const createWork = () => brokerApp.handle(new Request('http://main.local/v1/works', {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer a.b.c',
          'idempotency-key': `work-${randomUUID()}` },
        body: JSON.stringify({ profile: 'metadata-only-v1', authoring: 'own-work', language: 'en', title: 'Broker lane', actingSubject: agent }) }));

      // The relay has handed off nothing: the graph outbox backlog saturates the lane.
      const pending = await brokerSnapshot();
      expect(pending.profile).toBe(brokerProfile.id);
      expect(pending.lanes[1].state).toBe('saturated');
      expect(BigInt(pending.lanes[1].head!)).toBeGreaterThan(0n);
      expect(pending.lanes[1].delivered).toBe('0');
      const refusedWork = await createWork();
      expect(refusedWork.status).toBe(503);
      expect(refusedWork.headers.get('retry-after')).toBe('3');
      expect((await refusedWork.json() as { code: string }).code).toBe('backpressure_saturated');
      // Refused before graph admission, Account or Access: no new intent exists.
      expect(brokerVerified).toBe(0);

      // Handing off through the high water reopens admission; the command then
      // reaches its owners (and here fails Account verification, as configured).
      await pool.query('UPDATE relay.checkpoint SET sequence = $2 WHERE consumer = $1',
        [relayConsumer, pending.lanes[1].head]);
      expect((await brokerSnapshot()).lanes[1]).toMatchObject({ state: 'open', backlog: '0' });
      expect((await createWork()).status).toBe(401);
      expect(brokerVerified).toBe(1);

      // A checkpoint past its source is a gap, never negative backlog: fail closed.
      await pool.query('UPDATE relay.checkpoint SET sequence = sequence + 1 WHERE consumer = $1', [relayConsumer]);
      const gap = await createWork();
      expect(gap.status).toBe(503);
      expect((await gap.json() as { code: string }).code).toBe('backpressure_unavailable');
      expect((await brokerSnapshot()).lanes[1].state).toBe('unavailable');
      // A relay checkpoint from another data epoch is unprovable as well.
      await pool.query('UPDATE relay.checkpoint SET sequence = sequence - 1, data_epoch = $2 WHERE consumer = $1',
        [relayConsumer, randomUUID()]);
      expect((await createWork()).status).toBe(503);
      expect(brokerVerified).toBe(1);
      // Observation never moves the relay's own progress.
      expect((await pool.query<{ sequence: string }>(
        'SELECT sequence::text AS sequence FROM relay.checkpoint WHERE consumer = $1', [relayConsumer]))
        .rows[0]?.sequence).toBe(pending.lanes[1].head!);
    } finally {
      await relayReader.end();
    }
  } finally {
    await pool.end();
    execFileSync('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop'], { cwd: state });
    rmSync(state, { recursive: true, force: true });
  }
}, 240_000);
