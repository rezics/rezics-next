import { expect, mock, test } from 'bun:test';
import type { AccountActor } from '../../src/request/access.ts';

const original = '0192f3a0-6c1e-7b2a-9d4e-000000000001';
const moved = '0192f3a0-6c1e-7b2a-9d4e-000000000002';
const resolutions: string[] = [];
let observationCurrent = true;

mock.module('../../src/library/subject-anchor.ts', () => ({
  resolveSubject: async (_deps: unknown, _actor: unknown, id: string) => {
    const next = resolutions.shift();
    return { subjectId: next ?? id, requestedSubjectId: id };
  },
}));

mock.module('../../src/semantic/summaries.ts', () => ({
  readSubjectSummaryObservation: async (_deps: unknown, ids: readonly string[]) => ({
    current: async () => observationCurrent,
    summaries: new Map(ids.map((id) => [id, { id, type: 'schema:Book', label: { value: 'Book', language: 'en' } }])),
  }),
}));

const { fullView } = await import('../../src/library/views.ts');

const deps = {
  routeKey: new Uint8Array(32).fill(7),
  pool: {} as never,
  access: {} as never,
  tokens: { current: 1, keys: new Map() },
};
const actor: AccountActor = {
  kind: 'account',
  accountId: original,
  clientId: 'follow-withhold',
  scopes: ['follow:read', 'library_entry:read'],
  requestedBy: null,
  authnEpoch: 1,
};
const edge = {
  targetId: original,
  targetType: 'subject' as const,
  state: 'following' as const,
  reason: 'explicit' as const,
  updatedAt: '2026-11-06T00:00:00.000Z',
};

test('FULL follow withholds a changed Source and keeps the private edge', async () => {
  observationCurrent = true;
  resolutions.splice(0, resolutions.length, original, moved);
  const withheld = await fullView(deps, actor, 'FULL', { follows: [edge] }, { follow: true });
  expect(withheld.follows[0]).toEqual({ ...edge, target: null });
});

test('non-follow FULL still refuses a changed Source', async () => {
  observationCurrent = true;
  resolutions.splice(0, resolutions.length, original, moved);
  await expect(fullView(deps, actor, 'FULL', { libraryEntries: [{ subjectId: original }] })).rejects.toMatchObject({
    code: 'dependency_unavailable',
  });
});

test('FULL follow withholds when the summary observation is not current', async () => {
  observationCurrent = false;
  resolutions.splice(0, resolutions.length, original, original);
  const withheld = await fullView(deps, actor, 'FULL', { follows: [edge] }, { follow: true });
  expect(withheld.follows[0]).toEqual({ ...edge, target: null });
});
