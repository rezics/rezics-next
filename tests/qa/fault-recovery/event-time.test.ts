import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { engageAccessRecoveryFence, releaseAccessRecoveryFence }
  from '../../../services/main/src/modules/access/admission.ts';
import { EventObservationUnavailable, eventObservationDigest, eventTimeSlotIri,
  readEventObservationReceipt, setEventObservation }
  from '../../../services/main/src/modules/event/observation.ts';
import { EventQueryUnavailable, EventTemporalQueries }
  from '../../../services/main/src/modules/event/queries.ts';
import { GRAPHS, ID, iri, RV, type WorkActivationEnvironment }
  from '../../../services/main/src/modules/work/activate.ts';
import type { RegisteredAdmission } from '../../../services/main/src/modules/access/admission.ts';
import { cloneQaOwnerDatabases } from '../support/databases.ts';

const root = resolve(import.meta.dir, '../../..');

test('RATE09: Access recovery hold and a missing event manifest fail closed, then exact repair restores the histogram read', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.FUSEKI_URL || !Bun.env.ACCESS_DATABASE_URL
    || !Bun.env.MAIN_DATA_EPOCH || !Bun.env.MAIN_ROUTING_EPOCH) {
    throw new Error('Run through the isolated QA fault/recovery tier');
  }
  const stateDir = join(root, '.temp', `event-time-recovery-${randomUUID()}`);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const fuseki = new FusekiClient(Bun.env.FUSEKI_URL, Bun.env.FUSEKI_MAINTENANCE_TOKEN,
    Bun.env.FUSEKI_COMMAND_TOKEN);
  const databases = await cloneQaOwnerDatabases(Bun.env.REZICS_QA_RUN_ID, ['account', 'access'], 'owner');
  const access = new Pool({ connectionString: databases.urls.access, max: 4 });
  const env: WorkActivationEnvironment = { fuseki,
    lineage: { dataEpoch: Bun.env.MAIN_DATA_EPOCH, routingEpoch: Bun.env.MAIN_ROUTING_EPOCH },
    objectDirectory: join(stateDir, 'objects') };
  const event = `${ID}${randomUUID()}`, actor = `${ID}${randomUUID()}`;
  const input = { event, timeStatus: 'actual' as const, temporalKind: 'instant' as const,
    start: { state: 'known' as const, value: { kind: 'temporal' as const, lexical: '2026-08',
      precision: 'month' as const, calendar: 'gregorian' as const } }, expectedRevisionHead: null, actingSubject: actor };
  const admissionId = randomUUID();
  const admission: RegisteredAdmission = { id: admissionId, principalId: randomUUID(), actingSubject: actor,
    scope: `event:observe:${event}`, action: 'event.observation.set', idempotencyKey: `event-${admissionId}`,
    requestDigest: eventObservationDigest(input), authorityEpoch: '0', registeredAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(), state: 'claimed', dispatchEligible: true, replayed: false };
  const queries = new EventTemporalQueries(access, env, Buffer.alloc(32, 9));
  const request = () => queries.query({ interpretation: 'civil-date', match: 'possible', grain: 'day',
    start: '2026-08-05', end: '2026-08-05', pageSize: 5 });
  try {
    const receipt = await setEventObservation(env, admission, input);
    expect(receipt.outcome).toBe('succeeded');
    const accessFence = await engageAccessRecoveryFence(access);
    await expect(request()).rejects.toBeInstanceOf(EventQueryUnavailable);
    await releaseAccessRecoveryFence(access, accessFence);
    const first = await request() as { sourcePosition: { sequence: string }; items: { event: string }[] };
    expect(first.items.map(item => item.event)).toContain(event);

    const manifestRows = (await fuseki.query(`PREFIX rv: <${RV}> SELECT ?manifest WHERE {
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(receipt.revision!)} rv:manifest ?manifest } }`)).results?.bindings ?? [];
    const manifest = manifestRows[0]?.manifest?.value;
    if (!manifest?.startsWith('urn:rezics:sha256:')) throw new Error('event manifest was not retained');
    const objectPath = join(env.objectDirectory, manifest.slice('urn:rezics:sha256:'.length));
    const exactBytes = readFileSync(objectPath);
    unlinkSync(objectPath);
    await expect(request()).rejects.toBeInstanceOf(EventObservationUnavailable);
    writeFileSync(objectPath, exactBytes, { mode: 0o600, flag: 'wx' });
    const restored = await request() as { sourcePosition: { sequence: string }; items: { event: string }[] };
    expect(restored.sourcePosition.sequence).toBe(first.sourcePosition.sequence);
    expect(restored.items.map(item => item.event)).toContain(event);
    expect(eventTimeSlotIri(event, 'actual')).toBe(receipt.eventTime);
    expect(await readEventObservationReceipt(env, admission.id)).toMatchObject({ outcome: 'succeeded' });
  } finally {
    // Graph facts and their object directory remain paired for the QA project's lifetime.
    await access.end();
    await databases.close();
  }
});
