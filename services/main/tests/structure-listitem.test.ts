import { expect, test } from 'bun:test';
import { GRAPHS, RV, type WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { CompositionCorrupt, derivedId, readPlacements }
  from '../src/modules/structure/graph.ts';
import {
  CommandForbidden, CommandRejected, FusekiClient,
  type MembershipPreparationInput, type MembershipPreparationResult,
} from '../src/infrastructure/fuseki.ts';
import {
  hasUnnormalizedMembership, normalizeStoredMembership, upgradeStoredMembership,
} from '../src/modules/structure/membership-normalize.ts';

const id = (name: string) => derivedId(`list-item:${name}`);
const field = (value: string) => ({ type: 'uri', value });
const binding = (item?: string, legacyTarget?: string) => ({
  placement: field('urn:rezics:placement:legacy'), occurrence: field(id('occurrence')),
  type: field(`${RV}OccurrencePlacement`), segment: field(id('segment')),
  parent: field(id('structure')), segmentKey: { type: 'literal', value: '0' },
  orderKey: { type: 'literal', value: '1' }, role: field(`${RV}ChapterRole`),
  introducedBy: field(id('introduced')), mode: field(`${RV}FollowContext`),
  ...(item ? { item: field(item) } : {}),
  ...(legacyTarget ? { legacyTarget: field(legacyTarget) } : {}),
});
const env = (row: Omit<ReturnType<typeof binding>, 'mode'> & { mode?: ReturnType<typeof field> }): WorkActivationEnvironment => ({
  fuseki: { query: async (query: string) => {
    expect(query).toContain(`<${GRAPHS.current}>`);
    expect(query).toContain('schema:item ?item');
    expect(query).not.toContain('rv:target');
    return { results: { bindings: [row] } };
  } },
}) as unknown as WorkActivationEnvironment;

test('MODEL13: ListItem read requires normalized schema:item membership', async () => {
  const target = id('target');
  const generation = id('generation');
  for (const row of [binding(target)]) {
    const placements = await readPlacements(env(row), generation,
      { occurrences: [id('occurrence')] });
    expect(placements).toHaveLength(1);
    expect(placements[0]).toMatchObject({ occurrence: id('occurrence'), target,
      role: 'chapter', orderKey: '1' });
  }
  await expect(readPlacements(env(binding(undefined, target)), generation,
    { occurrences: [id('occurrence')] })).rejects.toBeInstanceOf(CompositionCorrupt);
});

test('ListItem group payload stays structural when read back for editing', async () => {
  const row = { ...binding(id('occurrence')), role: field(`${RV}GroupRole`), mode: undefined };
  const placements = await readPlacements(env(row), id('generation'),
    { occurrences: [id('occurrence')] });
  expect(placements[0]).toMatchObject({ role: 'group', occurrence: id('occurrence') });
  expect(placements[0]?.target).toBeUndefined();
});

const prepared = (complete = false, placements = 24): MembershipPreparationResult => ({
  status: 'committed', complete, placements, receipts: placements ? [`urn:rezics:receipt:membership:${placements}`] : [],
  examined: 256, phase: complete ? 4 : 0, after: complete ? '' : '0'.repeat(64), restarted: false,
});
const preparationEnv = (membershipPrepare: (
  input: MembershipPreparationInput, signal?: AbortSignal,
) => Promise<MembershipPreparationResult>): WorkActivationEnvironment => ({
  fuseki: { membershipPrepare },
  lineage: { dataEpoch: id('epoch'), routingEpoch: id('routing') },
  objectDirectory: '.temp/membership-normalization',
}) as unknown as WorkActivationEnvironment;

test('Membership preparation resumes native progress after a bounded interruption', async () => {
  const calls: MembershipPreparationInput[] = [];
  const environment = preparationEnv(async input => {
    calls.push(input);
    return prepared(calls.length === 3, calls.length === 3 ? 2 : 24);
  });
  const deadline = Date.now() + 60_000;
  expect(await normalizeStoredMembership(environment, 1, deadline)).toEqual({
    complete: false, placements: 24, receipts: ['urn:rezics:receipt:membership:24'],
  });
  expect(await normalizeStoredMembership(environment, 2, deadline)).toEqual({
    complete: true, placements: 26,
    receipts: ['urn:rezics:receipt:membership:24', 'urn:rezics:receipt:membership:2'],
  });
  expect(calls.every(call => call.deadline === deadline)).toBe(true);
  expect(new Set(calls.map(call => call.requestId)).size).toBe(3);
});

test('Membership preparation caps turns and makes no call past its wall deadline', async () => {
  let calls = 0;
  const environment = preparationEnv(async () => { calls++; return prepared(false, 0); });
  expect((await normalizeStoredMembership(environment, 256)).complete).toBe(false);
  expect(calls).toBe(256);
  expect(await normalizeStoredMembership(environment, 1, Date.now() - 1)).toEqual({
    complete: false, placements: 0, receipts: [],
  });
  expect(calls).toBe(256);
  for (const count of [0, 257, 1.5]) {
    await expect(normalizeStoredMembership(environment, count)).rejects.toThrow('1-256 write batches');
  }
});

test('Membership upgrade shares its one deadline and signal across preparation cycles', async () => {
  const calls: MembershipPreparationInput[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  const environment = preparationEnv(async (input, signal) => {
    calls.push(input); signals.push(signal);
    return prepared(calls.length === 257, 0);
  });
  expect((await upgradeStoredMembership(environment)).complete).toBe(true);
  expect(calls).toHaveLength(257);
  expect(new Set(calls.map(call => call.deadline)).size).toBe(1);
  expect(new Set(signals).size).toBe(1);
  expect(signals[0]?.aborted).toBe(false);
});

test('Membership preparation preserves native denials and conservative status', async () => {
  for (const result of [{ status: 'invalid', report: 'bad placement' }, { status: 'conflict' },
    { status: 'deadline' }, { status: 'unknown-profile' }] as const) {
    await expect(normalizeStoredMembership(preparationEnv(async () => result), 1))
      .rejects.toBeInstanceOf(CommandRejected);
  }
  const environment = preparationEnv(async () => ({ status: 'guard-unmatched' }));
  expect(await normalizeStoredMembership(environment, 1)).toEqual({ complete: false, placements: 0, receipts: [] });
  for (const needsPreparation of [true, false]) {
    expect(await hasUnnormalizedMembership({ membershipPreparationStatus: async () => ({ needsPreparation }) }))
      .toBe(needsPreparation);
  }
});

test('Native membership transport retries a lost acknowledgment with its exact input', async () => {
  const originalFetch = globalThis.fetch;
  const calls: RequestInit[] = [];
  globalThis.fetch = (async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push(init!);
    if (calls.length === 1) throw new TypeError('lost acknowledgment');
    return Response.json(prepared(true, 1));
  }) as unknown as typeof fetch;
  try {
    const input = { dataEpoch: id('epoch'), routingEpoch: id('routing'), requestId: 'exact-request', deadline: Date.now() + 60_000 };
    const client = new FusekiClient('http://example.test/', 'b'.repeat(64), 'a'.repeat(64));
    expect(await client.membershipPrepare(input)).toEqual(prepared(true, 1));
    expect(calls).toHaveLength(2);
    expect(calls[0]?.body).toBe(calls[1]?.body);
    expect(calls[0]?.signal).toBe(calls[1]?.signal);
    expect(JSON.parse(calls[0]?.body as string)).toEqual({ templateIndex: { operation: 'membership-prepare', ...input } });
    expect(calls[0]?.headers).toMatchObject({ authorization: `Bearer ${'a'.repeat(64)}` });
  } finally { globalThis.fetch = originalFetch; }
});

test('Native membership transport does not retry forbidden or malformed bounds', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  let response = new Response('', { status: 403 });
  globalThis.fetch = (async () => { calls++; return response; }) as unknown as typeof fetch;
  try {
    const client = new FusekiClient('http://example.test/', undefined, 'a'.repeat(64));
    const input = { dataEpoch: id('epoch'), routingEpoch: id('routing'), requestId: 'denied-request', deadline: Date.now() + 60_000 };
    await expect(client.membershipPrepare(input)).rejects.toBeInstanceOf(CommandForbidden);
    expect(calls).toBe(1);
    response = Response.json({ ...prepared(), placements: 25 });
    await expect(client.membershipPrepare(input)).rejects.toThrow('Malformed membership preparation bounds');
    expect(calls).toBe(2);
  } finally { globalThis.fetch = originalFetch; }
});

test('Native membership transport carries cancellation through bounded response reading', async () => {
  const originalFetch = globalThis.fetch;
  const cancellation = new AbortController();
  let cancelled = false;
  globalThis.fetch = (async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('{')); queueMicrotask(() => cancellation.abort()); },
    cancel() { cancelled = true; },
  }))) as unknown as typeof fetch;
  try {
    const client = new FusekiClient('http://example.test/', undefined, 'a'.repeat(64));
    await expect(client.membershipPrepare({ dataEpoch: id('epoch'), routingEpoch: id('routing'),
      requestId: 'cancelled-request', deadline: Date.now() + 60_000 }, cancellation.signal)).rejects.toThrow();
    expect(cancelled).toBe(true);
  } finally { globalThis.fetch = originalFetch; }
});
