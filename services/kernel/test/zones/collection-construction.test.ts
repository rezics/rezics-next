import { afterEach, expect, test } from 'bun:test';
import { ProblemError } from '../../src/http/problem-error.ts';
import { createZoneCollectionAdapter } from '../../src/library/zone-collection-adapter.ts';
import {
  bindZoneCollectionPort,
  requireZoneCollectionPort,
  unbindZoneCollectionPort,
  zoneCollectionResourceSchema,
} from '../../src/zones/collection-port.ts';
import { zoneWork } from '../../src/zones/membership.ts';

afterEach(() => {
  unbindZoneCollectionPort();
});

test('Zone collection port must be bound before membership work or mounted reads', () => {
  expect(() => requireZoneCollectionPort()).toThrow('Zone collection port is not composed');
  expect(() => zoneWork(Date.now() + 1000)).toThrow('Zone collection port is not composed');
  bindZoneCollectionPort(createZoneCollectionAdapter());
  const work = zoneWork(Date.now() + 1000);
  work.select('target', 'id', 1);
  expect(work.allowance().remaining.candidateKeys).toBeGreaterThan(0);
  expect(work.orderedAvailable()).toBe(true);
  expect(zoneCollectionResourceSchema()).toBeDefined();
});

test('bound Collection adapter projects public summaries and omits concealed mounts', () => {
  const port = bindZoneCollectionPort(createZoneCollectionAdapter());
  const reads = port.reads({
    pool: {} as never,
    access: {} as never,
    tokens: { current: 1, keys: new Map() },
  });
  const publicView = reads.projectPublic({
    id: '019a1b2c-3d4e-7f00-8a00-6a0010000001',
    membershipKind: 'curated',
    orderEpoch: 0,
    curatorAccountId: null,
    title: 'Mount',
    description: null,
    visibility: 'public',
    revision: 1,
    memberCount: 0,
    createdAt: '2026-01-01T00:00:00.000000Z',
    updatedAt: '2026-01-01T00:00:00.000000Z',
    presentationKind: null,
    presentationKindSource: 'owner',
    coverSource: 'none',
    allowedVisibilityActions: ['private'],
  });
  expect(publicView.id).toBe('019a1b2c-3d4e-7f00-8a00-6a0010000001');
  expect(publicView).not.toHaveProperty('allowedVisibilityActions');
  expect(reads.isConcealed(new ProblemError('not_found'))).toBe(true);
  expect(reads.isConcealed(new ProblemError('conflict'))).toBe(false);
});
