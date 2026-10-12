import { expect, test } from 'bun:test';
import {
  commandCounters,
  commandPhases,
} from '../../../packages/observability/src/http-measurement.ts';
import {
  assertWorkCost,
  assertWorkCostAtScales,
  profileRequest,
  summarizeWorkProfile,
  WorkProfileError,
  type WorkCostContract,
  type WorkProfile,
  type WorkSpan,
} from '../support/work-profile.ts';

const traceId = '1'.repeat(32),
  parent = '2'.repeat(16);
function span(
  id: string,
  parentSpanId: string,
  attributes: Record<string, unknown>,
  kind = 2,
): WorkSpan {
  return {
    traceId,
    spanId: id.repeat(16),
    parentSpanId,
    service: 'main',
    name: 'safe',
    kind,
    startMs: 100,
    endMs: 150,
    attributes,
  };
}
const root = span('3', parent, { 'http.response.status_code': 200 }, 1);
function fuseki(id: string, attributes: Record<string, unknown> = {}): WorkSpan {
  return span(id, root.spanId, {
    'http.request.method': 'POST',
    'rezics.peer.service': 'fuseki',
    ...attributes,
  });
}
function profile(attributes: Record<string, unknown> = {}): WorkProfile {
  return summarizeWorkProfile([root, fuseki('4', attributes)], traceId, parent, 60);
}
function costs(values: number[]): WorkProfile[] {
  return values.map((value) => profile({ 'rezics.fuseki.public_name_heads_visited': value }));
}

test('native counters sum every allowlisted field once per descendant Fuseki span, without timers or siblings', () => {
  const counters = Object.fromEntries(commandCounters.map((name) => [`rezics.fuseki.${name}`, 2]));
  const timers = Object.fromEntries(commandPhases.map((name) => [`rezics.fuseki.${name}_ms`, 100]));
  const first = fuseki('4', { ...counters, ...timers, 'rezics.fuseki.engine_ms': 150 });
  const second = fuseki('5', { 'rezics.fuseki.public_name_heads_visited': 3 });
  const sibling = { ...fuseki('6', counters), parentSpanId: parent };
  const foreign = { ...fuseki('7', counters), traceId: '9'.repeat(32) };
  const sql = span('8', root.spanId, {
    'db.system.name': 'postgresql',
    'rezics.fuseki.public_name_heads_visited': 100,
  });
  const measured = summarizeWorkProfile(
    [root, first, first, second, sibling, foreign, sql],
    traceId,
    parent,
    60,
  );
  expect(measured.nativeVisits).toEqual(
    Object.fromEntries(
      commandCounters.map((name) => [name, name === 'public_name_heads_visited' ? 5 : 2]),
    ),
  );
  expect(measured.nativeVisitTotal).toBe(commandCounters.length * 2 + 3);
});

test('query counters survive without commit timing and missing counters are an empty measured inventory', () => {
  const measured = profile({ 'rezics.fuseki.public_name_heads_visited': 0 });
  expect(measured.nativeVisits).toEqual({ public_name_heads_visited: 0 });
  expect(measured.nativeVisitTotal).toBe(0);
  expect(measured.fusekiCalls[0]!.nativeWork).toBeNull();
  expect(profile().nativeVisits).toEqual({});
  expect(profile().nativeVisitTotal).toBe(0);
  const noCalls = summarizeWorkProfile([root], traceId, parent, 60);
  expect(noCalls.nativeVisits).toEqual({});
  expect(noCalls.nativeVisitTotal).toBe(0);
});

test('unknown native attributes and malformed or overflowing counters refuse the profile', () => {
  expect(() => profile({ 'rezics.fuseki.unreviewed_visited': 1 })).toThrow('not allowlisted');
  expect(() => profile({ 'rezics.fuseki.unreviewed_visited': 1 })).toThrow(WorkProfileError);
  const unknown = { ...profile(), nativeVisits: { unreviewed_visited: 1 } };
  expect(() => assertWorkCostAtScales([unknown, unknown, unknown], {})).toThrow(WorkProfileError);
  for (const value of [-1, 1.5, Infinity, NaN, '3', Number.MAX_SAFE_INTEGER + 1])
    expect(() => profile({ 'rezics.fuseki.public_name_heads_visited': value })).toThrow(
      'counter is invalid',
    );
  expect(() =>
    summarizeWorkProfile(
      [
        root,
        fuseki('4', { 'rezics.fuseki.public_name_heads_visited': Number.MAX_SAFE_INTEGER }),
        fuseki('5', { 'rezics.fuseki.public_name_heads_visited': 1 }),
      ],
      traceId,
      parent,
      60,
    ),
  ).toThrow('safe integer bounds');
  expect(() =>
    profile({
      'rezics.fuseki.public_name_heads_visited': Number.MAX_SAFE_INTEGER,
      'rezics.fuseki.public_name_labels_visited': 1,
    }),
  ).toThrow('safe integer bounds');
});

test('profileRequest retains native counts and missing collection still fails', async () => {
  const measured = await profileRequest(
    {
      collect: async (requestTrace, requestParent) => [
        { ...root, traceId: requestTrace, parentSpanId: requestParent },
        { ...fuseki('4', { 'rezics.fuseki.public_name_heads_visited': 7 }), traceId: requestTrace },
      ],
    },
    async () => 'read',
  );
  expect(measured.result).toBe('read');
  expect(measured.profile.nativeVisits).toEqual({ public_name_heads_visited: 7 });
  await expect(profileRequest({ collect: async () => [] }, async () => 'read')).rejects.toThrow(
    'server span',
  );
});

test('native fields and their total default to constant growth, including the existing tolerance', () => {
  for (const values of [
    [10, 10, 10],
    [10, 11, 12],
    [10, 9, 8],
    [0, 0, 0],
  ])
    expect(() => assertWorkCostAtScales(costs(values), {})).not.toThrow();
  for (const values of [
    [4, 16, 64],
    [10, 13, 10],
    [0, 0, 1],
  ])
    expect(() => assertWorkCostAtScales(costs(values), {})).toThrow('Cost growth contract failed');
  const balanced = [4, 16, 64].map((value) =>
    profile({
      'rezics.fuseki.public_name_heads_visited': value,
      'rezics.fuseki.public_name_labels_visited': 100 - value,
    }),
  );
  expect(() => assertWorkCostAtScales(balanced, {})).toThrow(
    'nativeVisits.public_name_heads_visited',
  );
});

test('native counters absent at any scale fail even when present counters are zero or growth is allowed', () => {
  for (const profiles of [
    [profile(), ...costs([0, 0])],
    [costs([1])[0]!, profile(), costs([1])[0]!],
    [...costs([0, 0]), profile()],
  ])
    expect(() => assertWorkCostAtScales(profiles, {})).toThrow('is absent at a scale');
  expect(() =>
    assertWorkCostAtScales([profile(), ...costs([16, 64])], {
      growth: {
        'nativeVisits.public_name_heads_visited': {
          class: 'linear',
          dimension: 'mainCalls',
          reason: 'Page size grows with the supplied scale.',
        },
      },
    }),
  ).toThrow('is absent at a scale');
});

test('native maxima resolve individual counters and the total', () => {
  const measured = costs([7])[0]!;
  assertWorkCost(measured, { 'nativeVisits.public_name_heads_visited': 7, nativeVisitTotal: 7 });
  expect(() => assertWorkCost(measured, { 'nativeVisits.public_name_heads_visited': 6 })).toThrow(
    '7 > 6',
  );
  expect(() => assertWorkCost(measured, { nativeVisitTotal: 6 })).toThrow('7 > 6');
  expect(() => assertWorkCost(profile(), { 'nativeVisits.public_name_heads_visited': 7 })).toThrow(
    'unobserved',
  );
});

test('explicit reasoned native growth allowances compose with total growth and absolute maxima', () => {
  const profiles = costs([4, 16, 64]).map((value, index) => ({
    ...value,
    dimensions: { threads: [4, 16, 64][index]! },
  }));
  const allowance = {
    class: 'linear',
    dimension: 'threads',
    reason: 'The requested page size grows with the scale.',
  } as const;
  const contract: WorkCostContract = {
    nativeVisitTotal: 64,
    growth: {
      nativeVisitTotal: allowance,
      'nativeVisits.public_name_heads_visited': allowance,
    },
  };
  expect(() => assertWorkCostAtScales(profiles, contract)).not.toThrow();
  expect(() => assertWorkCostAtScales(profiles, { ...contract, nativeVisitTotal: 63 })).toThrow(
    '64 > 63',
  );
  expect(() =>
    assertWorkCostAtScales(profiles, {
      growth: { 'nativeVisits.public_name_heads_visited': allowance },
    }),
  ).toThrow('nativeVisitTotal (constant)');
  expect(() =>
    assertWorkCostAtScales(profiles, { growth: { nativeVisitTotal: allowance } }),
  ).toThrow('nativeVisits.public_name_heads_visited (constant)');
  expect(() =>
    assertWorkCostAtScales(profiles, {
      growth: { nativeVisitTotal: { ...allowance, reason: ' ' } },
    }),
  ).toThrow('requires a reason');
  const seeks = costs([3, 5, 7]).map((value, index) => ({
    ...value,
    dimensions: { threads: [4, 16, 64][index]! },
  }));
  const seek = {
    class: 'logarithmic',
    dimension: 'threads',
    reason: 'One index seek per tree level.',
  } as const;
  expect(() =>
    assertWorkCostAtScales(seeks, {
      growth: { nativeVisitTotal: seek, 'nativeVisits.public_name_heads_visited': seek },
    }),
  ).not.toThrow();
});
