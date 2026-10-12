import { expect, test } from 'bun:test';
import {
  assertWorkCostAtScales,
  assertWorkMeterObserved,
  summarizeWorkProfile,
  WorkMeterBlindError,
  type WorkCostContract,
  type WorkObservationContract,
  type WorkProfile,
  type WorkSpan,
} from '../support/work-profile.ts';

const traceId = '1'.repeat(32),
  parent = '2'.repeat(16);
const root: WorkSpan = {
  traceId,
  spanId: '3'.repeat(16),
  parentSpanId: parent,
  service: 'main',
  name: 'read',
  kind: 1,
  startMs: 100,
  endMs: 150,
  attributes: { 'http.response.status_code': 200 },
};
function profile(peer?: string): WorkProfile {
  const spans = [root];
  if (peer)
    spans.push({
      ...root,
      spanId: '4'.repeat(16),
      parentSpanId: root.spanId,
      kind: 2,
      attributes: {
        'http.request.method': 'GET',
        ...(peer === 'unclassified' ? {} : { 'rezics.peer.service': peer }),
      },
    });
  return summarizeWorkProfile(spans, traceId, parent, 60);
}
function blindAt(index: number, blind: WorkProfile, contract: WorkCostContract = {}): void {
  const profiles = Array.from({ length: 3 }, () => ({ ...profile(), postgresStatements: 1 }));
  profiles[index] = blind;
  try {
    assertWorkCostAtScales(profiles, contract);
    throw new Error('Expected a meter-blind failure');
  } catch (error) {
    expect(error).toBeInstanceOf(WorkMeterBlindError);
    expect((error as WorkMeterBlindError).code).toBe('WORK_PROFILE_METER_BLIND');
    expect((error as WorkMeterBlindError).traceId).toBe(traceId);
    expect((error as Error).message).toContain('meter is blind');
  }
}

test('other or unclassified fetches with no attributed calls fail at every scale before maxima or growth verdicts', () => {
  for (const peer of ['other', 'unclassified'])
    for (const index of [0, 1, 2])
      blindAt(index, profile(peer), {
        otherFetches: 0,
        growth: {
          postgresStatements: { class: 'constant', dimension: 'mainCalls' },
        },
      });
  const original = profile('other');
  expect(original.postgresStatements).toBe(0);
  expect(original.fusekiRequests).toBe(0);
  expect(original.otherFetches).toBe(1);
  const unknown = profile('unclassified');
  expect(unknown.unclassifiedFetches).toBe(1);
  expect(unknown.postgresStatements).toBeNull();
});

test('omitted or empty minimumObserved refuses zero attributed calls at every successful scale', () => {
  for (const status of [200, 201, 204, 299])
    for (const contract of [{}, { minimumObserved: {} }])
      for (const index of [0, 1, 2])
        blindAt(index, { ...profile(), request: { ...profile().request, status } }, contract);
});

test('minimumObserved refuses a successful read with no calls at any scale and validates declared minima', () => {
  for (const index of [0, 1, 2])
    blindAt(index, profile(), { minimumObserved: { postgresStatements: 1 } });
  for (const minimum of [0, -1, 1.5, Infinity, NaN])
    expect(() =>
      assertWorkMeterObserved(profile(), { minimumObserved: { fusekiRequests: minimum } }),
    ).toThrow('Invalid minimum');
  expect(() =>
    assertWorkMeterObserved(
      { ...profile(), postgresStatements: 1 },
      { minimumObserved: { postgresStatements: 2 } },
    ),
  ).toThrow(WorkMeterBlindError);
  expect(() =>
    assertWorkMeterObserved(
      { ...profile(), fusekiRequests: null },
      { minimumObserved: { fusekiRequests: 1 } },
    ),
  ).toThrow(WorkMeterBlindError);
});

test('attributed SQL or Fuseki satisfies observation', () => {
  for (const field of ['postgresStatements', 'fusekiRequests'] as const) {
    const observed = { ...profile(), [field]: 1 };
    expect(() =>
      assertWorkMeterObserved(observed, { minimumObserved: { [field]: 1 } }),
    ).not.toThrow();
    expect(() =>
      assertWorkCostAtScales([observed, observed, observed], { minimumObserved: { [field]: 1 } }),
    ).not.toThrow();
    const mixed = { ...profile('other'), [field]: 1 };
    expect(() => assertWorkCostAtScales([mixed, mixed, mixed], { otherFetches: 1 })).not.toThrow();
  }
});

test('a zero-call successful profile is meter blind with or without a minimum', () => {
  const noCalls = profile();
  expect(() => assertWorkCostAtScales([noCalls, noCalls, noCalls], {})).toThrow(
    WorkMeterBlindError,
  );
  expect(() =>
    assertWorkCostAtScales([noCalls, noCalls, noCalls], { minimumObserved: {} }),
  ).toThrow(WorkMeterBlindError);
  expect(() => assertWorkMeterObserved(noCalls)).toThrow(WorkMeterBlindError);
});

test('a removed no-backend allowance is ignored at runtime and cannot excuse a zero-call profile', () => {
  const noCalls = profile();
  const stale = { noBackendCalls: true, reason: 'health snapshot' };
  expect(() =>
    assertWorkCostAtScales([noCalls, noCalls, noCalls], stale as unknown as WorkCostContract),
  ).toThrow(WorkMeterBlindError);
  expect(() =>
    assertWorkMeterObserved(noCalls, stale as unknown as WorkObservationContract),
  ).toThrow(WorkMeterBlindError);
});

test('meter validation does not turn unsuccessful reads or incomplete attribution into growth verdicts', () => {
  const refused = { ...profile(), request: { ...profile().request, status: 503 } };
  expect(() =>
    assertWorkCostAtScales([refused, refused, refused], {
      minimumObserved: { postgresStatements: 1 },
    }),
  ).toThrow('request status: 503');
  const attributed = { ...profile('unclassified'), postgresStatements: 1 };
  expect(() =>
    assertWorkCostAtScales([attributed, attributed, attributed], { postgresStatements: 2 }),
  ).toThrow('unobserved fetch peer classification');
  const partiallyBlind = [profile('fuseki'), profile('other'), profile('fuseki')];
  expect(() => assertWorkCostAtScales(partiallyBlind, {})).toThrow(WorkMeterBlindError);
});
