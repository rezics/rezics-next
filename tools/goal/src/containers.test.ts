import { expect, test } from 'bun:test';
import { staleContainers } from './containers.ts';

test('only old containers that no running task names and no keep prefix covers are stale', () => {
  const hour = 3_600_000,
    now = 100 * hour;
  const rows = [
    { id: 'old', name: 'focused_yalow', createdMs: now - 7 * hour },
    { id: 'young', name: 'nice_greider', createdMs: now - hour },
    { id: 'kept', name: 'rezics-dev-fuseki-1', createdMs: now - 200 * hour },
    { id: 'owned', name: 'rezics-kernel-schema-a61d3d3d', createdMs: now - 9 * hour },
  ];
  const policy = { maxAgeHours: 4, keep: ['rezics-dev-'] };
  expect(staleContainers(rows, policy, ['a61d3d3d-0000-0000-0000-000000000000'], now)).toEqual(['old']);
});
