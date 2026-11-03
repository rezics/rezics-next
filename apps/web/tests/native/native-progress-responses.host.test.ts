import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import {
  createNativeProgressResponsesFixture,
  PROGRESS_RESPONSE_HEADERS,
  PROGRESS_RESPONSE_SCENARIOS,
  type NativeProgressResponse,
  type NativeProgressResponseManifest,
  type NativeProgressResponsesFixture,
  type NativeProgressScenarioName,
} from './native-progress-responses-fixture.ts';

setDefaultTimeout(900_000);
let fixture: NativeProgressResponsesFixture;
let manifest: NativeProgressResponseManifest;
beforeAll(async () => {
  fixture = await createNativeProgressResponsesFixture();
  manifest = fixture.manifest;
}, 900_000);
afterAll(async () => fixture?.close(), 180_000);

function facts(name: NativeProgressScenarioName): NativeProgressResponse[] {
  const scenario = manifest.scenarios[name];
  expect(scenario.availability).toBe('produced');
  if (scenario.availability !== 'produced') throw new Error(`${name}: ${scenario.missingInterface}`);
  expect(scenario.responseSequences.length).toBeGreaterThan(0);
  return scenario.responseSequences.map((sequence) => manifest.responses[sequence]!);
}
function body(name: NativeProgressScenarioName): Record<string, any> {
  return facts(name)[0]!.body as Record<string, any>;
}

test('exports a closed reviewer mapping with byte-preserving native facts and honest source/build identity', () => {
  expect(Object.keys(manifest.scenarios).sort()).toEqual(Object.keys(PROGRESS_RESPONSE_SCENARIOS).sort());
  expect(manifest.reviewer).toHaveLength(Object.keys(PROGRESS_RESPONSE_SCENARIOS).length);
  for (const [name, mapping] of Object.entries(PROGRESS_RESPONSE_SCENARIOS)) {
    const scenario = manifest.scenarios[name as NativeProgressScenarioName];
    expect(manifest.reviewer.find((row) => row.export === `manifest.scenarios.${name}`)).toEqual({
      ...mapping, export: `manifest.scenarios.${name}`, availability: scenario.availability,
      responseSequences: scenario.availability === 'produced' ? scenario.responseSequences : scenario.observedResponseSequences,
    });
  }
  expect(manifest.producer.entryPoint).toBe('createNativeHoldingsHistoryFixture');
  expect(manifest.producer.subjects.map(({ type }) => type)).toEqual(['schema:Book', 'schema:Recipe', 'schema:Person']);
  expect(manifest.producer.definitionsDigest).toBeTruthy();
  expect(manifest.identity.source.revision).toMatch(/^[a-f0-9]{40}$/);
  expect(manifest.identity.source.clean).toBe(true);
  expect(manifest.identity.sourceAfter).toEqual(manifest.identity.source);
  expect(manifest.identity.runtime).toMatchObject({ engine: 'Bun', version: Bun.version });
  expect(manifest.identity.build.availability).toBe('dependency_unavailable');
  expect(manifest.identity.currentDevRecording).toBe(false);
  for (const [sequence, fact] of manifest.responses.entries()) {
    expect(fact.sequence).toBe(sequence);
    expect(fact.path).toStartWith('/v1/progressSessions');
    expect(fact.body).toEqual(JSON.parse(fact.bodyText));
    expect(fact.temporal).toBe('current_at_capture');
    expect(Number.isFinite(Date.parse(fact.capturedAt))).toBe(true);
    expect(Object.keys(fact.headers).every((name) => PROGRESS_RESPONSE_HEADERS.includes(name as never))).toBe(true);
    expect(fact.headers).not.toHaveProperty('set-cookie');
    expect(fact.headers).not.toHaveProperty('authorization');
    expect(fact.bodyText).not.toMatch(/"(?:access_token|refresh_token|authorization|cookie|signature)"\s*:/i);
  }
});

test('keeps original command inputs, keys and observed revisions separate from returned facts', () => {
  const keys = new Set<string>();
  for (const command of manifest.commands) {
    const response = manifest.responses[command.responseSequence]!;
    expect(response).toMatchObject({ method: command.method, path: command.path, persona: command.persona });
    expect(command.input.body).toEqual(JSON.parse(command.input.bodyText));
    expect(command.input.commandKey).toMatch(/^"[a-f0-9-]{36}"$/);
    expect(keys.has(command.input.commandKey)).toBe(false);
    keys.add(command.input.commandKey);
    expect(response.body).not.toHaveProperty('commandKey');
    const input = command.input.body as Record<string, unknown>;
    if (command.observedRevision) {
      const observed = manifest.responses[command.observedRevision.responseSequence]!;
      expect(observed.sequence).toBeLessThan(response.sequence);
      expect((observed.body as any).progressSession.revision).toBe(command.observedRevision.revision);
      expect(input.revision).toBe(command.observedRevision.revision);
      expect((response.body as any).progressSession.revision).toBe(command.observedRevision.revision + 1);
    } else expect(input).not.toHaveProperty('revision');
  }
  expect(manifest.commands.filter(({ path }) => path.endsWith(':record')).map(({ input }) => input.body))
    .toEqual([{ revision: 1, amount: '0' }, { revision: 2, amount: '125' }, { revision: 3, amount: '0' }]);
  expect(manifest.commands.length).toBe(manifest.responses.filter(({ method }) => method === 'POST').length);
});

test('retains zero, accepted scalar units and FULL meaning without deriving percentages or historic meaning', () => {
  const scalar = body('ownerDetail').progressSession;
  expect(scalar).toMatchObject({ mode: 'scalar_amount', unit: 'page', amount: '0', total: '300', completedUnitCount: 0 });
  expect(body('zeroDetail').progressSession).toEqual(scalar);
  expect(scalar.presentation).toMatchObject({ meaning: 'known', structure: 'unverified', recording: { state: 'supported' } });
  expect(scalar).toHaveProperty('subject');
  expect(scalar).toHaveProperty('versionSubject');
  expect(scalar).not.toHaveProperty('percentage');
  expect(scalar).not.toHaveProperty('percent');
  expect(scalar).not.toHaveProperty('sourceIdentity');
  expect(scalar).not.toHaveProperty('acceptingType');
  expect(body('recipeDetail').progressSession).toMatchObject({ mode: 'scalar_amount', unit: 'minute', total: '90' });
  expect(body('completedDetail').progressSession).toMatchObject({ id: scalar.id, state: 'completed', amount: '0' });
  const reread = body('rereadDetail').progressSession;
  expect(reread.id).not.toBe(scalar.id);
  expect(reread).toMatchObject({ state: 'active', revision: 1, amount: null, total: null });
  expect(new Set(body('ownerIndex').progressSessions.map((session: any) => session.id))).toEqual(new Set([scalar.id, reread.id]));
  for (const name of ['ownerDetail', 'zeroDetail', 'recipeDetail', 'rereadDetail', 'completedDetail'] as const) {
    const fact = facts(name)[0]!;
    expect(fact.path).toEndWith('?view=FULL&presentation=FULL');
    expect(fact.headers['cache-control']).toBe('private, no-store');
  }
});

test('retains actual independent history pages, duplicate intent order, IDs and original timestamps', () => {
  const changes = facts('changes');
  expect(changes.length).toBeGreaterThan(1);
  const rows = changes.flatMap((fact) => (fact.body as any).changes);
  expect(rows.map(({ intent }) => intent)).toEqual([{ amount: '0' }, { amount: '125' }, { amount: '0' }]);
  const sessionId = body('ownerDetail').progressSession.id;
  expect(rows.map(({ id }) => id)).toEqual([`${sessionId}:2`, `${sessionId}:3`, `${sessionId}:4`]);
  expect(rows.map(({ revision }) => revision)).toEqual([2, 3, 4]);
  expect(rows.every(({ createdAt }) => typeof createdAt === 'string' && Number.isFinite(Date.parse(createdAt)))).toBe(true);
  for (const [list, history] of Object.entries(manifest.histories)) {
    expect(history.addressField).toBe(list);
    for (const [index, page] of history.pages.entries()) {
      const response = manifest.responses[page.responseSequence]!;
      const query = new URL(response.path, 'https://native.test').searchParams;
      expect(query.get('cursor')).toBe(page.requestedCursor);
      expect(page.requestedCursor).toBe(index === 0 ? null : (manifest.responses[history.pages[index - 1]!.responseSequence]!.body as any).next);
      expect(Object.keys(response.body as object).sort()).toEqual([list === 'changes' ? 'changes' : 'completedUnits', 'next'].sort());
    }
    expect((manifest.responses[history.pages.at(-1)!.responseSequence]!.body as any).next).toBeNull();
    const first = manifest.responses[history.pages[0]!.responseSequence]!;
    const reset = manifest.responses[history.reset.responseSequence]!;
    const retried = manifest.responses[history.retry.responseSequence]!;
    expect(history.reset.intent).toBe('reset');
    expect(reset.path).toBe(first.path);
    expect(reset.bodyText).toBe(first.bodyText);
    expect(history.retry.intent).toBe('retry');
    expect(retried.path).toBe(manifest.responses[(history.pages[1] ?? history.pages[0])!.responseSequence]!.path);
  }
  expect(body('units')).toEqual({ completedUnits: [], next: null });
  expect(manifest.histories.units.pages).toHaveLength(1);
  expect(facts('crossListCursor')[0]!.status).toBe(400);
  expect(body('crossListCursor').code).toBe('invalid_cursor');
  expect(new URL(facts('crossListCursor')[0]!.path, 'https://native.test').searchParams.get('cursor')).toBe((changes[0]!.body as any).next);
});

test('actual other, anonymous and suspended reads never disclose the private owner session or history', () => {
  expect(body('otherIndex')).toEqual({ progressSessions: [], next: null });
  for (const [name, status] of [
    ['otherDetail', 404], ['otherChanges', 404], ['otherUnits', 404], ['missingDetail', 404],
    ['anonymousIndex', 401], ['anonymousDetail', 401], ['anonymousChanges', 401], ['anonymousUnits', 401],
    ['suspendedDetail', 401],
  ] as const) {
    const fact = facts(name)[0]!;
    expect(fact.status).toBe(status);
    expect(fact.body).not.toHaveProperty('progressSession');
    expect(fact.body).not.toHaveProperty('changes');
    expect(fact.body).not.toHaveProperty('completedUnits');
    expect(fact.bodyText).not.toContain(body('ownerDetail').progressSession.id);
  }
  expect(body('suspendedDetail').code).toBe('invalid_credentials');
});

test('absent mode, history, outage and terminal producers remain explicit dependencies, never fake positives', () => {
  for (const name of ['unsupportedCursor', 'unsupportedUnits', 'unsupportedProfile'] as const) {
    expect(facts(name)[0]!.status).toBe(422);
    expect(body(name).code).toBe('unsupported_library_profile');
  }
  for (const name of ['unitsLater', 'noncontiguousUnits', 'historicalUnit', 'emptyWithContinuation', 'unavailableDetail', 'terminalAccount'] as const) {
    const scenario = manifest.scenarios[name];
    expect(scenario.availability).toBe('dependency_unavailable');
    expect(scenario).not.toHaveProperty('responseSequences');
    if (scenario.availability === 'dependency_unavailable') expect(scenario.missingInterface.length).toBeGreaterThan(20);
  }
  expect(manifest.responses.some(({ status }) => status === 503)).toBe(false);
  expect(manifest.responses.some(({ body }) => (body as any).progressSession?.mode === 'completed_units')).toBe(false);
});
