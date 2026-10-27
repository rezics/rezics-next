import { afterEach, beforeEach, expect, setDefaultTimeout, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  LibraryTypePreparationDriver,
  PreparationCrash,
  PreparationFixture,
} from './library-type-preparation-driver.ts';

setDefaultTimeout(240_000);
let driver: LibraryTypePreparationDriver;
beforeEach(async () => {
  const location = process.env.LIBRARY_TYPE_PREPARATION_DRIVER;
  if (!location) throw new Error('Library type preparation outcome driver is required');
  if (!isAbsolute(location) && !location.startsWith('file:'))
    throw new Error('LIBRARY_TYPE_PREPARATION_DRIVER must be absolute or a file URL');
  const url = isAbsolute(location) ? pathToFileURL(location) : new URL(location);
  if (url.protocol !== 'file:') throw new Error('LIBRARY_TYPE_PREPARATION_DRIVER must use a file URL');
  const binding = await import(url.href);
  if (typeof binding.createLibraryTypePreparationDriver !== 'function')
    throw new Error('Expected createLibraryTypePreparationDriver factory');
  driver = await binding.createLibraryTypePreparationDriver();
});
afterEach(async () => {
  const current = driver;
  driver = undefined!;
  await current?.close();
});
const longType = 'schema:' + 'A'.repeat(256 * 205);
const put = (f: PreparationFixture, state: 'planned' | 'completed' = 'planned') =>
  driver.request(f, 'PUT', `/v1/libraryEntries/${f.subjectId}`, { state }, f.requestKey);
const json = (value: unknown) => JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
async function staged(type = longType) {
  const f = await driver.fixture({ type, digest: 'constant', requestBudgetMs: 3000 });
  await driver.primeType(f, 'schema:Primary');
  const before = (await driver.inspect(f)).effects;
  const pending = await put(f);
  expect(pending.status).toBe(503);
  expect(await pending.json()).toMatchObject({ status: 503, retryable: true });
  expect((await driver.inspect(f)).effects).toEqual(before);
  return f;
}
async function create(f: PreparationFixture, type: string) {
  let response = await put(f);
  if (response.status === 503) {
    await driver.settleMetadata();
    response = await put(f);
  }
  expect(response.status).toBe(201);
  const body = await response.json();
  expect(body.libraryEntry).toMatchObject({ state: 'planned', revision: 1 });
  const state = await driver.inspect(f);
  const typeId = await driver.lookup(f, type);
  expect(typeId).not.toBeNull();
  expect(state.effects.entries).toHaveLength(1);
  expect(state.effects.entries[0]?.typeId).toBe(typeId!);
  expect(state.effects.operations).toEqual([]);
  return body;
}

test('ordinary exact root hit and root miss complete promptly with the existing put shape', async () => {
  for (const hit of [false, true]) {
    const f = await driver.fixture({ type: 'schema:Book', requestBudgetMs: 3000 });
    if (hit) await driver.primeType(f, 'schema:Book');
    const response = await put(f);
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(Object.keys(body)).toEqual(['libraryEntry']);
    expect(body.libraryEntry).toMatchObject({ subjectId: f.subjectId, state: 'planned', revision: 1 });
    const state = await driver.inspect(f);
    expect(state.dictionary.filter((v) => v.type === 'schema:Book')).toHaveLength(1);
    expect(state.requests).toHaveLength(1);
    expect(state.requests[0]!.returnedAt).toBeLessThan(state.requests[0]!.deadline);
    expect(state.requests[0]!.continuationTransactions).toBe(0);
    expect(state.requests[0]!.reservationTransactions).toBeLessThanOrEqual(1);
    expect(state.reservations).toEqual([]);
  }
});

test('forced equal digest long values use bounded native pages and never workflow text', async () => {
  for (const size of [51_207, 102_407, 2_048_007]) {
    for (const varied of [false, true]) {
      const text = 'schema:' + (varied ? randomBytes(size).toString('hex').slice(0, size) : 'A'.repeat(size));
      const f = await staged(text);
      const initial = await driver.inspect(f);
      expect(initial.reservations).toHaveLength(1);
      expect(initial.reservations[0]!.storage).toBe('e');
      expect(initial.requests[0]!.reservationTransactions).toBe(1);
      expect(initial.requests[0]!.continuationTransactions).toBe(0);
      expect(initial.requests[0]!.sourceConnectionsWhileWaiting).toBe(0);
      expect(initial.requests[0]!.accountConnectionsWhileWaiting).toBe(0);
      await driver.settleMetadata();
      const state = await driver.inspect(f);
      expect(state.effects).toEqual(initial.effects);
      expect(state.pages.length).toBeGreaterThan(1);
      expect(new Set(state.pages.map((p) => p.transactionId)).size).toBe(state.pages.length);
      for (const p of state.pages) {
        expect(p.edgeOperations).toBeLessThanOrEqual(100);
        expect(p.sliceBytes).toBeLessThanOrEqual(25_600);
        expect(p.sliceStatements).toBeLessThanOrEqual(1);
        expect(p.offsetAfter - p.offsetBefore).toBe(p.sliceBytes);
        expect(p.stagingWholeValueBytes).toBe(0);
        expect(p.accountShareLocked && p.gateChecked && p.sourceChecked).toBe(true);
      }
      expect(state.pages.reduce((n, p) => n + p.sliceBytes, 0)).toBe(Buffer.byteLength(text));
      expect(json(state.workflowPayloads)).not.toContain(text);
      expect(json(state.workflowPayloads)).not.toContain(text.slice(7, 263));
      for (const payload of state.workflowPayloads) expect(Buffer.byteLength(json(payload))).toBeLessThan(4096);
      await create(f, text);
    }
  }
});

test('strict extensions and distinct equal digest types never alias their primary or each other', async () => {
  const f = await staged();
  await driver.settleMetadata();
  await driver.primeType(f, longType + 'B');
  await driver.primeType(f, longType.slice(0, -1) + 'C');
  const keys = await Promise.all(
    ['schema:Primary', longType, longType + 'B', longType.slice(0, -1) + 'C'].map((type) => driver.lookup(f, type)),
  );
  expect(keys.every((key) => key !== null)).toBe(true);
  expect(new Set(keys).size).toBe(4);
});

test('every native commit enqueue ack and final receipt crash gap recovers without a user effect', async () => {
  const gaps: PreparationCrash[] = [
    'reserve-before-commit',
    'reserve-after-commit-before-enqueue',
    'reserve-after-enqueue-before-ack',
    'page-before-commit',
    'page-after-commit-before-enqueue',
    'page-after-enqueue-before-ack',
    'page-after-ack-before-dispatch',
    'final-before-commit',
    'final-after-commit-before-ack',
  ];
  for (const gap of gaps) {
    const f = await driver.fixture({ type: longType, digest: 'constant', requestBudgetMs: 3000 });
    await driver.primeType(f, 'schema:Primary');
    const before = (await driver.inspect(f)).effects;
    await driver.crashNext(f, gap);
    await put(f).catch(() => undefined); // A killed real connection may have no HTTP response.
    await driver.settleMetadata().catch(() => undefined);
    await driver.recover();
    // A pre-commit crash needs a fresh request; a committed intent recovers without one.
    if (gap === 'reserve-before-commit') expect((await put(f)).status).toBe(503);
    await driver.settleMetadata();
    const recovered = await driver.inspect(f);
    expect(recovered.effects).toEqual(before);
    expect(recovered.dictionary.filter((v) => v.type === longType)).toHaveLength(1);
    expect(recovered.pageReceipts.length).toBeGreaterThan(0);
    expect(new Set(recovered.pageReceipts.map((r) => `${r.preparationId}/${r.chunk}/${r.offset}`)).size).toBe(
      recovered.pageReceipts.length,
    );
    const body = await create(f, longType);
    const committed = (await driver.inspect(f)).effects;
    expect(await (await put(f)).json()).toEqual(body);
    expect((await driver.inspect(f)).effects).toEqual(committed);
  }
});

test('original key retry after transient 503 creates exactly one ordinary entry', async () => {
  const f = await staged();
  await driver.settleMetadata();
  const body = await create(f, longType);
  const state = (await driver.inspect(f)).effects;
  const replay = await put(f);
  expect(replay.status).toBe(201);
  expect(await replay.json()).toEqual(body);
  expect((await driver.inspect(f)).effects).toEqual(state);
});

test('same key changed user body retains the original digest conflict after preparation', async () => {
  const f = await staged();
  await driver.settleMetadata();
  await create(f, longType);
  const before = (await driver.inspect(f)).effects;
  const changed = await put(f, 'completed');
  expect(changed.status).toBe(422);
  expect(await changed.json()).toMatchObject({ code: 'idempotency_conflict' });
  expect((await driver.inspect(f)).effects).toEqual(before);
});

test('entry commit before response loss replays the original receipt and status', async () => {
  const f = await staged();
  await driver.settleMetadata();
  await driver.crashNext(f, 'entry-after-commit-before-response');
  await put(f).catch(() => undefined);
  await driver.recover();
  const before = (await driver.inspect(f)).effects;
  expect(before.entries).toHaveLength(1);
  expect((await put(f)).status).toBe(201);
  expect((await driver.inspect(f)).effects).toEqual(before);
});

test('source revision during staging requires fresh evidence for the same original request key', async () => {
  const f = await staged();
  const old = (await driver.inspect(f)).evidence[0]!;
  const currentType = 'schema:Revised' + 'B'.repeat(30_000);
  await driver.reviseType(f, currentType);
  await driver.settleMetadata();
  await create(f, currentType);
  const state = await driver.inspect(f);
  const used = state.ready.find((v) => v.typeId === state.effects.entries[0]!.typeId)!;
  expect(used.evidence.binding).not.toEqual(old.binding);
});

test('merge during staging observes the survivor separately on its authoritative RR client', async () => {
  const f = await staged();
  const survivorType = 'schema:Survivor';
  const { survivorId } = await driver.mergeSource(f, survivorType);
  await driver.settleMetadata();
  await create(f, survivorType);
  const state = await driver.inspect(f);
  expect(state.effects.entries[0]!.subjectId).toBe(survivorId);
  expect(state.effects.entries[0]!.sourceId).toBe(survivorId);
  expect(state.observations.some((o) => o.sourceId === f.subjectId)).toBe(true);
  expect(state.observations.some((o) => o.sourceId === survivorId)).toBe(true);
  for (const o of state.observations) {
    expect(o.partitionClient).toBe(o.typeClient);
    expect(o.partitionClient).toBe(o.redirectClient);
    expect(o.isolation).toBe('repeatable read');
    expect(o.releasedBeforeAccount).toBe(true);
  }
});

test('owner epoch change cannot trap the original request in an old preparation receipt', async () => {
  const f = await staged();
  const old = (await driver.inspect(f)).evidence[0]!.binding;
  await driver.rebuildOwner(f);
  await driver.settleMetadata();
  await create(f, longType);
  const state = await driver.inspect(f);
  const used = state.ready.find((v) => v.typeId === state.effects.entries[0]!.typeId)!;
  expect(BigInt(used.evidence.binding.ownerEpoch)).toBeGreaterThan(BigInt(old.ownerEpoch));
});

test('deletion barrier wins before late publication and resumed work never restores erased payloads', async () => {
  const f = await staged();
  const intent = (await driver.inspect(f)).intents.at(-1)!;
  expect(intent).toBeDefined();
  const pause = await driver.pauseNext(f, 'before-publication');
  const work = driver.settleMetadata();
  try {
    await pause.reached;
    await driver.deleteOwner(f);
  } finally {
    await pause.resume();
    await work;
  }
  const deleted = await driver.inspect(f);
  expect(deleted.dictionary).toEqual([]);
  expect(deleted.reservations).toEqual([]);
  expect(deleted.evidence).toEqual([]);
  await driver.redeliver(intent).catch(() => undefined);
  await driver.recover();
  await driver.settleMetadata();
  const after = await driver.inspect(f);
  expect(after.dictionary).toEqual([]);
  expect(after.reservations).toEqual([]);
  expect(after.evidence).toEqual([]);
  expect(after.effects).toEqual(deleted.effects);
  expect((await put(f)).status).toBe(403);
});

test('missing evidence and stale reservation deliveries fail closed and require fresh observations', async () => {
  for (const damage of ['missing-evidence', 'stale-reservation'] as const) {
    const f = await staged();
    const intent = await driver.damage(f, damage);
    const before = (await driver.inspect(f)).effects;
    await driver.redeliver(intent).catch(() => undefined);
    expect(await driver.lookup(f, longType)).toBeNull();
    expect((await driver.inspect(f)).effects).toEqual(before);
    await create(f, longType);
  }
});

test('concurrent same identity distinct native input rejects the invariant without aliasing', async () => {
  const f = await driver.fixture({ type: longType, digest: 'constant' });
  await driver.primeType(f, 'schema:Primary');
  const before = (await driver.inspect(f)).effects;
  const results = await driver.raceConflictingInput(f);
  expect(results).toHaveLength(2);
  expect(results.some((r) => r.status === 'rejected')).toBe(true);
  expect((await driver.inspect(f)).effects).toEqual(before);
  await driver.settleMetadata();
  await create(f, longType);
});

test('ready metadata confers no current entry authority and no revision count or activity before put', async () => {
  const f = await staged();
  const before = (await driver.inspect(f)).effects;
  await driver.settleMetadata();
  expect((await driver.inspect(f)).effects).toEqual(before);
  await driver.revokeEntryAccess(f);
  expect((await put(f)).status).toBe(403);
  expect((await driver.inspect(f)).effects).toEqual(before);
});

test('source changes after readiness are revalidated before entry consumes the prepared key', async () => {
  const f = await staged();
  await driver.settleMetadata();
  const pause = await driver.pauseNext(f, 'before-entry-effect');
  const pending = put(f);
  try {
    await pause.reached;
    await driver.reviseType(f, 'schema:Current');
  } finally {
    await pause.resume();
  }
  expect([201, 503]).toContain((await pending).status);
  await create(f, 'schema:Current');
});

test('missing source and closed gate stop staged publication without a permanent invalid type', async () => {
  for (const fault of ['source', 'gate'] as const) {
    const f = await staged();
    const before = (await driver.inspect(f)).effects;
    if (fault === 'source') await driver.removeSource(f);
    else await driver.closeGate(f);
    await driver.settleMetadata();
    expect(await driver.lookup(f, longType)).toBeNull();
    expect((await driver.inspect(f)).effects).toEqual(before);
    expect([403, 404, 503]).toContain((await put(f)).status);
    expect((await driver.inspect(f)).effects).toEqual(before);
  }
});

test('initial owner and subject Access denial produces no preparation or user effects', async () => {
  for (const persona of ['unreadable', 'revoked'] as const) {
    const f = await driver.fixture({ type: longType, digest: 'constant' });
    const before = await driver.inspect(f);
    const response = await driver.request(
      f,
      'PUT',
      `/v1/libraryEntries/${f.subjectId}`,
      { state: 'planned' },
      f.requestKey,
      persona,
    );
    expect([403, 404]).toContain(response.status);
    const after = await driver.inspect(f);
    expect(after.metadataRows).toEqual(before.metadataRows);
    expect(after.effects).toEqual(before.effects);
  }
});

test('caller supplied actor source type and stamps are rejected before metadata allocation', async () => {
  const f = await driver.fixture({ type: longType });
  const before = await driver.inspect(f);
  const body = {
    state: 'planned',
    actor: { accountId: f.accountId },
    sourceId: f.subjectId,
    type: 'schema:Forged',
    source: { partition: 1, epoch: 1, position: '1' },
    ownerEpoch: '1',
  };
  expect((await driver.request(f, 'PUT', `/v1/libraryEntries/${f.subjectId}`, body, f.requestKey)).status).toBe(400);
  const after = await driver.inspect(f);
  expect(after.metadataRows).toEqual(before.metadataRows);
  expect(after.effects).toEqual(before.effects);
});

test('concurrent same identity same input converges and retries create one ordinary entry', async () => {
  const f = await driver.fixture({ type: longType, digest: 'constant', requestBudgetMs: 3000 });
  await driver.primeType(f, 'schema:Primary');
  const before = (await driver.inspect(f)).effects;
  const initial = await Promise.all([put(f), put(f)]);
  expect(initial.map((r) => r.status)).toEqual([503, 503]);
  expect((await driver.inspect(f)).effects).toEqual(before);
  await driver.settleMetadata();
  const results = await Promise.all([put(f), put(f)]);
  expect(results.map((r) => r.status)).toEqual([201, 201]);
  expect(await results[0]!.json()).toEqual(await results[1]!.json());
  const after = await driver.inspect(f);
  expect(after.effects.entries).toHaveLength(1);
  expect(after.effects.entries[0]!.revision).toBe(1);
  expect(after.dictionary.filter((v) => v.type === longType)).toHaveLength(1);
});

test('unknown READ type filters allocate no dictionary preparation receipt event or user effect', async () => {
  const f = await driver.fixture({ type: 'schema:Book' });
  const before = await driver.inspect(f);
  for (const path of [
    '/v1/libraryEntries?orderBy=createdAt&type=schema%3AUnknown',
    '/v1/libraryShelfSummary?type=schema%3AUnknown',
  ]) {
    expect((await driver.request(f, 'GET', path)).status).toBe(400);
  }
  const after = await driver.inspect(f);
  expect(after.metadataRows).toEqual(before.metadataRows);
  expect(after.dictionary).toEqual(before.dictionary);
  expect(after.effects).toEqual(before.effects);
});
