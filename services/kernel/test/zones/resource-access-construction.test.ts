import { afterEach, expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { composeZoneResource } from '../../src/composition/zones.ts';
import {
  bindZoneResourceAccess,
  unbindZoneResourceAccess,
  zoneResourceAccess,
  type ZoneResourceAccessPort,
} from '../../src/zones/resource-access-port.ts';
import {
  createZoneResourceApplication,
  unbindZoneResourceApplication,
  zoneResourceApplication,
} from '../../src/zones/resource-application.ts';
import { zoneReadEligibility } from '../../src/zones/eligibility.ts';
import { createZoneResourceAccessProducer } from '../../src/access/zone-resource-adapter.ts';
import { GrantDeniedError } from '../../src/access/resource-access-errors.ts';

function fakePort(calls: string[]): ZoneResourceAccessPort {
  return {
    requireDeadline: () => {
      calls.push('requireDeadline');
    },
    commandAccessContext: (context) => {
      calls.push('commandAccessContext');
      return context;
    },
    parentCreationAuthorization: () => {
      calls.push('parentCreationAuthorization');
      throw new Error('fake has no parent creation');
    },
    resourceAuthorizationPage: () => {
      calls.push('resourceAuthorizationPage');
      throw new Error('fake has no resource authorization');
    },
    initializeResourceGrants: async () => {
      calls.push('initializeResourceGrants');
    },
    prepareAction: async () => {
      calls.push('prepareAction');
      return null;
    },
    authorizeAction: async () => {
      calls.push('authorizeAction');
      return false;
    },
    checkAction: async () => {
      calls.push('checkAction');
      return async () => false;
    },
    createPublicEligibility: () => {
      calls.push('createPublicEligibility');
      return { fake: true };
    },
    readAccount: async () => {
      calls.push('readAccount');
      return {
        id: '019a1b2c-3d4e-7f00-8a00-6a0010000001',
        kind: 'actor',
        state: 'active',
        fenced: false,
        minimumAuthnEpoch: 0n,
        transactionId: 'tx',
      };
    },
    readAccountActionStates: async () => {
      calls.push('readAccountActionStates');
      return [{ id: '019a1b2c-3d4e-7f00-8a00-6a0010000001', kind: 'actor', state: 'active', fenced: false }];
    },
    withReadTransaction: async (_pool, work) => {
      calls.push('withReadTransaction');
      return work({ query: async () => ({ rows: [], rowCount: 0 }) } as never);
    },
    isGrantDenied: (error) => {
      calls.push('isGrantDenied');
      return error instanceof Error && error.name === 'GrantDeniedError';
    },
    grantDenied: () => {
      calls.push('grantDenied');
      const error = new Error('Access grant administration denied');
      error.name = 'GrantDeniedError';
      return error;
    },
    authenticationRequired: () => {
      calls.push('authenticationRequired');
      return new Error('Authentication failed');
    },
  };
}

afterEach(() => {
  unbindZoneResourceApplication();
  unbindZoneResourceAccess();
});

test('Zone resource Access port must be bound before eligibility or owner-account reads', () => {
  expect(() => zoneResourceAccess()).toThrow('Zone resource Access port is not composed');
  expect(() => zoneReadEligibility({ route: 0, id: '019a1b2c-3d4e-7f00-8a00-6a0010000001' })).toThrow(
    'Zone resource Access port is not composed',
  );
});

test('resource application constructs commands and reads through a fake Access port', async () => {
  const calls: string[] = [];
  const port = fakePort(calls);
  bindZoneResourceAccess(port);
  const application = createZoneResourceApplication(port);
  const runtime = application.runtime({
    pool: {} as Pool,
    access: {},
    tokens: { current: 1, keys: new Map([[1, new Uint8Array(32)]]) },
    clock: () => new Date('2026-01-01T00:00:00.000Z'),
  });
  expect(typeof runtime.commands.create).toBe('function');
  expect(typeof runtime.commands.mutate).toBe('function');
  expect(typeof runtime.commands.platform).toBe('function');
  expect(typeof runtime.reads.metadata).toBe('function');
  expect(typeof runtime.reads.list).toBe('function');
  expect(typeof runtime.reads.page).toBe('function');
  expect(application.ifMatch('"12"')).toBe('12');
  expect(() => application.requireAccount({ kind: 'anonymous' })).toThrow('Authentication failed');
  expect(calls).toContain('authenticationRequired');
  expect(zoneReadEligibility({ route: 1, id: '019a1b2c-3d4e-7f00-8a00-6a0010000001' })).toEqual({ fake: true });
  expect(calls).toContain('createPublicEligibility');
  expect(port.isGrantDenied(port.grantDenied())).toBe(true);
  expect(await port.readAccount({ query: async () => ({ rows: [] }) } as never, 1, 'account')).toMatchObject({
    state: 'active',
    fenced: false,
  });
});

test('ordinary composition binds the Access producer and constructs the live resource application', () => {
  const application = composeZoneResource();
  expect(zoneResourceAccess()).toBe(application.access);
  expect(zoneResourceApplication()).toBe(application);
  expect(typeof application.runtime).toBe('function');
  expect(createZoneResourceAccessProducer().isGrantDenied(new GrantDeniedError())).toBe(true);
  expect(createZoneResourceAccessProducer().isGrantDenied(new Error('forbidden'))).toBe(false);
});
