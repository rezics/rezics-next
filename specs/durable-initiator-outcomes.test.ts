import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  Anchor,
  Attack,
  Attempt,
  DurableInitiatorDriver,
  Fixture,
  Mutation,
  Point,
  SeedMode,
} from './durable-initiator-driver.ts';

// The support verifier proves executable RED cases, never native authorization.
setDefaultTimeout(300_000);
let driver: DurableInitiatorDriver | undefined;
async function setup() {
  const location = process.env.DURABLE_INITIATOR_DRIVER_MODULE;
  if (!location) throw new Error('Missing durable initiator driver');
  if (!isAbsolute(location) && !location.startsWith('file:')) {
    throw new Error('DURABLE_INITIATOR_DRIVER_MODULE must be an absolute path or file URL');
  }
  const url = isAbsolute(location) ? pathToFileURL(location) : new URL(location);
  if (url.protocol !== 'file:') throw new Error('Durable initiator driver must use a file URL');
  const binding = await import(url.href);
  if (typeof binding.createDurableInitiatorDriver !== 'function') {
    throw new Error('Durable initiator driver must export createDurableInitiatorDriver');
  }
  driver = await binding.createDurableInitiatorDriver();
  return driver!;
}
afterEach(async () => {
  const current = driver;
  driver = undefined;
  await current?.close();
});

async function create(d: DurableInitiatorDriver, mode: SeedMode = 'delegated') {
  const f = await d.seed(mode);
  expect(f.accessToken.length).toBeGreaterThan(0);
  expect(f.refreshToken.length).toBeGreaterThan(0);
  expect(f.tuple.scopes.length).toBeGreaterThan(0);
  expect(Number.isSafeInteger(f.tuple.authnEpoch)).toBe(true);
  expect(BigInt(f.tuple.recordedFloor)).toBeLessThanOrEqual(BigInt(f.tuple.authnEpoch));
  expect(f.tuple.delegator === null).toBe(mode !== 'delegated');
  const result = await d.create(f);
  expect(result.outcome).toBe('committed');
  if (result.outcome !== 'committed') throw new Error('Real authenticated native creation failed');
  const op = result.operation;
  const state = await d.inspect(op);
  expect(state.operation).toMatchObject({
    anchor: op,
    kind: 'content.author_erasure',
    key: f.key,
    tuple: f.tuple,
    target: { threadId: f.threadId, authorId: f.authorId },
  });
  const row = state.operation!;
  expect(row.digest).toMatch(/^[a-f0-9]{64}$/);
  expect(row.purpose.length).toBeGreaterThan(0);
  expect(row.workflowId.length).toBeGreaterThan(0);
  expect(row.source.partition).toBe(op.route >>> 4);
  expect(BigInt(row.source.position)).toBeGreaterThan(0n);
  expect(row.source.epoch).toBeGreaterThan(0);
  expect(row.source.eventIndex).toBeGreaterThanOrEqual(0);
  expect(state.creationReceipt).toMatchObject({
    transactionId: row.transactionId,
    key: f.key,
    digest: row.digest,
    operation: op,
  });
  expect(state.creationReceipt!.id.length).toBeGreaterThan(0);
  const points = await d.points(op);
  expect(points.filter((p) => p.kind === 'step').length).toBeGreaterThanOrEqual(1);
  expect(points.some((p) => p.kind === 'result')).toBe(true);
  expect(points.some((p) => p.kind === 'cached-result')).toBe(true);
  expect(new Set(points.map((p) => p.id)).size).toBe(points.length);
  return { f, op, points };
}

function nativeReads(attempt: Attempt) {
  // Operation checkout must finish before independent evidence/resource reads.
  const live = new Set<string>();
  const operationConnections = new Set<string>();
  let operationRead = false;
  for (const event of attempt.reads) {
    if (event.kind === 'acquire') {
      expect(live.has(event.connection)).toBe(false);
      live.add(event.connection);
    } else if (event.kind === 'release') {
      expect(live.delete(event.connection)).toBe(true);
    } else if (event.kind === 'read') {
      expect(live.has(event.connection)).toBe(true);
      expect(event.partitions.length).toBeLessThanOrEqual(1);
      expect(event.anchor.length).toBeGreaterThan(0);
      if (event.stage === 'operation') {
        operationRead = true;
        operationConnections.add(event.connection);
      } else {
        expect(operationRead).toBe(true);
        for (const connection of operationConnections) expect(live.has(connection)).toBe(false);
      }
    }
  }
  expect(live.size).toBe(0);
  expect(operationRead).toBe(true);
  for (const stage of ['provenance', 'account', 'resource']) {
    expect(attempt.reads.some((e) => e.kind === 'read' && e.stage === stage)).toBe(true);
  }
}

function time(attempt: Attempt, point: Point) {
  expect(Number.isFinite(Date.parse(attempt.at))).toBe(true);
  expect(typeof attempt.time).toBe('object');
  expect(attempt.checks.length).toBeGreaterThan(0);
  expect(
    attempt.checks.some(
      (c) =>
        c.action === point.action && c.resource.id === point.resource.id && c.resource.route === point.resource.route,
    ),
  ).toBe(true);
  for (const check of attempt.checks) {
    expect(check.at).toBe(attempt.at);
    expect(check.time).toBe(attempt.time);
  }
}

async function allowed(d: DurableInitiatorDriver, op: Anchor, point: Point) {
  const before = await d.inspect(op);
  const attempt = await d.advance(op, point.id);
  expect(attempt.result.outcome).toBe('permitted');
  time(attempt, point);
  expect(attempt.checks.every((c) => c.allowed)).toBe(true);
  nativeReads(attempt);
  const after = await d.inspect(op);
  expect(after.operation).toEqual(before.operation);
  if (point.kind === 'step') {
    expect(after.protected.effects.length).toBeGreaterThan(before.protected.effects.length);
    expect(after.protected.receipts.length).toBeGreaterThan(before.protected.receipts.length);
  } else {
    expect(attempt.result).toHaveProperty('value');
    expect(after.protected).toEqual(before.protected);
  }
  return attempt;
}

async function denies(d: DurableInitiatorDriver, op: Anchor, point: Point, attack?: Attack, input?: unknown) {
  const before = await d.inspect(op);
  const firstStep = point.kind === 'step' ? (await d.points(op)).find((p) => p.kind === 'step') : undefined;
  const attempt = attack ? await d.attack(op, point.id, attack, input) : await d.advance(op, point.id);
  // Exact shape excludes cached value, operation content, receipt and replay flag.
  expect(attempt.result).toEqual({ outcome: 'denied' });
  const after = await d.inspect(op);
  expect(after.operation).toEqual(before.operation);
  expect(after.protected).toEqual(before.protected);
  expect(after.creationReceipt).toEqual(before.creationReceipt);
  // Cleanup may finish erasures committed by earlier protected batches after denial.
  if (firstStep?.id === point.id) expect(after.cleanup).toEqual(before.cleanup);
  return attempt;
}

// Only the baseline's kinds are shared with fresh operations of the same fixture
// shape. Every checkpoint ID still comes from that operation's native registry.
const sequences = new WeakMap<DurableInitiatorDriver, Point['kind'][]>();

async function sequence(d: DurableInitiatorDriver, op: Anchor) {
  let points = await d.points(op);
  let steps = points.filter((p) => p.kind === 'step');
  for (let index = 0; index < steps.length; index++) {
    const point = steps[index]!;
    await d.park(op, point.id);
    await allowed(d, op, point);
    points = await d.points(op);
    const reached = points.filter((p) => p.kind === 'step');
    expect(reached.slice(0, steps.length)).toEqual(steps);
    steps = reached;
  }
  expect(steps.length).toBeGreaterThanOrEqual(2);
  expect(points.some((p) => p.kind === 'result')).toBe(true);
  expect(points.some((p) => p.kind === 'cached-result')).toBe(true);
  expect(new Set(points.map((p) => p.id)).size).toBe(points.length);
  const kinds: Point['kind'][] = [...steps.map((p) => p.kind), 'result', 'cached-result'];
  sequences.set(d, kinds);
  return kinds;
}

async function pointAt(d: DurableInitiatorDriver, op: Anchor, index: number) {
  const kind = index === 0 ? 'step' : sequences.get(d)?.[index];
  expect(kind).toBeDefined();
  let points = await d.points(op);
  if (kind !== 'step') {
    const point = points.find((p) => p.kind === kind);
    expect(point).toBeDefined();
    return point!;
  }
  let steps = points.filter((p) => p.kind === 'step');
  while (index >= steps.length) {
    const last = steps[steps.length - 1]!;
    await d.park(op, last.id);
    await allowed(d, op, last);
    points = await d.points(op);
    const reached = points.filter((p) => p.kind === 'step');
    expect(reached.slice(0, steps.length)).toEqual(steps);
    expect(reached.length).toBeGreaterThan(steps.length);
    steps = reached;
  }
  return steps[index]!;
}

async function positive(d: DurableInitiatorDriver, index: number, mode: SeedMode = 'delegated') {
  const c = await create(d, mode);
  const point = await pointAt(d, c.op, index);
  expect(point).toBeDefined();
  await d.park(c.op, point.id);
  await allowed(d, c.op, point);
}

async function changed(d: DurableInitiatorDriver, f: Fixture, axis: Mutation) {
  const before = await d.authority(f);
  const at = await d.mutate(f, axis);
  const after = await d.authority(f);
  expect(Number.isFinite(Date.parse(at))).toBe(true);
  expect(after).not.toEqual(before);
  if (axis === 'actor-grant' || axis === 'principal-grant') {
    const field = axis === 'actor-grant' ? 'actorGrants' : 'principalGrants';
    expect(after[field]).not.toEqual(before[field]);
    expect({ ...after, [field]: before[field] }).toEqual(before);
  }
  if (axis.startsWith('consent-')) {
    expect(after.consentScopes).not.toEqual(before.consentScopes);
    expect(after.actorGrants).toEqual(before.actorGrants);
    expect(after.principalGrants).toEqual(before.principalGrants);
    expect(after.delegation).toEqual(before.delegation);
  }
  if (axis === 'client-missing') expect(after.clientExists).toBe(false);
  if (axis.startsWith('delegation-')) {
    expect(after.delegation).not.toEqual(before.delegation);
    expect(after.actorGrants).toEqual(before.actorGrants);
    expect(after.principalGrants).toEqual(before.principalGrants);
    expect(after.consentScopes).toEqual(before.consentScopes);
  }
  if (axis === 'epoch-floor-increased') expect(BigInt(after.floor)).toBeGreaterThan(BigInt(before.floor));
  if (axis === 'fenced') expect(after.fenced).toBe(true);
  if (axis === 'suspended') expect(after.state).toBe('suspended');
  if (axis === 'tombstoned') expect(after.state).toBe('deleted');
  return at;
}

test('durable committed initiator survives bearer expiry without persisting a token', async () => {
  const d = await setup();
  const baseline = await create(d);
  const kinds = await sequence(d, baseline.op);
  const { f, op } = await create(d);
  const original = (await d.inspect(op)).operation;
  await d.passOriginalExpiry(f);
  await d.restart();
  for (let index = 0; index < kinds.length; index++) {
    const point = await pointAt(d, op, index);
    await d.park(op, point.id);
    const attempt = await allowed(d, op, point);
    expect(Date.parse(attempt.at)).toBeGreaterThan(Date.parse(f.expiresAt));
    expect((await d.inspect(op)).operation).toEqual(original);
  }
  const state = await d.inspect(op);
  expect(state.durableRecords.length).toBeGreaterThan(0);
  const serialized = JSON.stringify(state.durableRecords);
  expect(serialized).not.toContain(f.accessToken);
  expect(serialized).not.toContain(f.refreshToken);
  expect(serialized).not.toMatch(/"(?:access_token|refresh_token|authorization|bearer|actorContext)"\s*:/i);
  expect(serialized).not.toMatch(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
  const workflowRecords = state.durableRecords.filter((r) => r.source.startsWith('dbos-'));
  expect(workflowRecords.length).toBeGreaterThan(0);
  expect(JSON.stringify(workflowRecords)).not.toMatch(/"(?:actor|scopes|authnEpoch|authn_epoch|recordedFloor)"\s*:/);
});

test('each later step and result rechecks current three-operand formula and recorded ceilings', async () => {
  const d = await setup();
  const baseline = await create(d);
  const kinds = await sequence(d, baseline.op);
  for (let index = 0; index < kinds.length; index++) {
    for (const axis of ['actor-grant', 'principal-grant', 'consent-reduced'] as const) {
      await positive(d, index);
      const { f, op } = await create(d);
      const point = await pointAt(d, op, index);
      await d.park(op, point.id);
      const at = await changed(d, f, axis);
      const attempt = await denies(d, op, point);
      expect(Date.parse(attempt.at)).toBeGreaterThanOrEqual(Date.parse(at));
    }
  }
  // Current grants can be restored without broadening the recorded scope set.
  const current = await create(d);
  const point = current.points[0]!;
  await d.park(current.op, point.id);
  await changed(d, current.f, 'actor-grant');
  await d.grant(current.f, 'restore-actor');
  await d.restart();
  await allowed(d, current.op, point);
  for (const kind of ['result', 'cached-result'] as const) {
    // Creation returns the same disclosure as the result, so its tuple includes the result action.
    const full = await create(d);
    const result = full.points.find((p) => p.kind === kind)!;
    await d.grant(full.f, 'add-outside-action');
    await d.park(full.op, result.id);
    await allowed(d, full.op, result);
    const tuple = (await d.inspect(full.op)).operation!.tuple;
    expect(tuple).toEqual(full.f.tuple);
    expect(tuple.scopes).not.toContain(full.f.outsideAction);
  }
});

const revocations: readonly Mutation[] = [
  'suspended',
  'tombstoned',
  'fenced',
  'account-missing',
  'epoch-floor-increased',
  'client-missing',
  'consent-missing',
  'consent-revoked',
  'consent-reduced',
  'delegation-missing',
  'delegation-changed-actor',
  'delegation-changed-principal',
  'delegation-revoked',
];

// One case per mutation family keeps each case within its timeout on one shared check slot.
for (const axis of revocations) {
  test(`suspension fence epoch consent delegation revocations deny independently: ${axis}`, async () => {
    const d = await setup();
    const baseline = await create(d);
    const kinds = await sequence(d, baseline.op);
    for (let index = 0; index < kinds.length; index++) {
      await positive(d, index);
      const { f, op } = await create(d);
      const point = await pointAt(d, op, index);
      await d.park(op, point.id);
      await changed(d, f, axis);
      await d.restart();
      await denies(d, op, point);
    }
  });
}

test('operation provenance target or tuple substitution denies', async () => {
  const d = await setup();
  const attacks: Attack[] = [
    'actor',
    'client',
    'delegator',
    'scopes',
    'oversized-anchor',
    'oversized-tuple',
    'oversized-key',
    'epoch',
    'recorded-floor',
    'operation-id',
    'operation-key',
    'operation-digest',
    'operation-kind',
    'partition',
    'domain',
    'thread',
    'author',
    'purpose',
    'resource',
    'action',
    'copied-row',
    'missing-row',
    'missing-receipt',
    'uncommitted-receipt',
    'rolled-back-create',
    'other-operation-receipt',
    'changed-transaction',
    'missing-source',
    'changed-source',
    'fixture-callback',
    'other-access',
    'other-pool',
    'originally-stale-tuple',
    'refresh-stale-floor',
  ];
  for (const attack of attacks) {
    await positive(d, 0);
    const { op, points } = await create(d);
    await d.park(op, points[0]!.id);
    await denies(d, op, points[0]!, attack);
  }
});

test('current organization membership, Realm membership and the Realm ban retain the native formula', async () => {
  const d = await setup();
  for (const [mode, axes] of [
    ['organization', ['organization-membership']],
    ['realm', ['realm-membership', 'realm-block']],
  ] as const) {
    const baseline = await create(d, mode);
    const kinds = await sequence(d, baseline.op);
    for (const axis of axes) {
      for (let index = 0; index < kinds.length; index++) {
        await positive(d, index, mode);
        const { f, op } = await create(d, mode);
        const point = await pointAt(d, op, index);
        await d.park(op, point.id);
        await changed(d, f, axis);
        await denies(d, op, point);
      }
    }
  }
});

test('native public floor and direct initiator retain existing scope and grant semantics', async () => {
  const d = await setup();
  const baseline = await create(d, 'direct');
  const kinds = await sequence(d, baseline.op);
  const direct = await create(d, 'direct');
  for (let index = 0; index < kinds.length; index++) {
    const point = await pointAt(d, direct.op, index);
    await d.park(direct.op, point.id);
    await allowed(d, direct.op, point);
  }
  const floor = await create(d, 'direct');
  await changed(d, floor.f, 'actor-grant');
  const read = await d.readPublic(floor.op);
  expect(floor.f.tuple.scopes).not.toContain(read.point.action);
  expect(read.anonymous.result.outcome).toBe('permitted');
  expect(read.restored.result.outcome).toBe('permitted');
  time(read.restored, read.point);
  nativeReads(read.restored);
  // Captured scope still cannot supply a private grant branch.
  const privateCase = await create(d);
  await d.park(privateCase.op, privateCase.points[0]!.id);
  await changed(d, privateCase.f, 'actor-grant');
  await denies(d, privateCase.op, privateCase.points[0]!);
});

test('workflow context caller clocks and previous step evidence cannot install durable authority', async () => {
  const d = await setup();
  for (const attack of [
    'serialized-actor',
    'bearer-context',
    'resigned-jwt',
    'caller-time',
    'reuse-step-proof',
  ] as const) {
    await positive(d, 0);
    const { f, op, points } = await create(d);
    await d.park(op, points[0]!.id);
    await denies(d, op, points[0]!, attack, {
      actor: f.tuple,
      authorization: f.accessToken,
      at: '2000-01-01T00:00:00.000Z',
    });
  }
});
