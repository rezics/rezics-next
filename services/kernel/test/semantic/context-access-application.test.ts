import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { composeSemanticContext } from '../../src/composition/semantic-context.ts';
import {
  bindContextAccess,
  CONTEXT_GLOBAL_ID,
  contextAccess,
  type ContextAccessPort,
  type ContextQueryClient,
} from '../../src/semantic/context-access-port.ts';
import { createContextApplication } from '../../src/semantic/context-application.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';

type PortOptions = {
  beforeReadDecisions?: () => Promise<void>;
  resourceAuthorization?: () => never;
};

function makePort(name: string, calls: string[], options: PortOptions = {}): ContextAccessPort {
  return {
    deadlineClient: (client) => client,
    requireDeadline: () => {
      calls.push(`${name}:requireDeadline`);
    },
    withReadTransaction: async (_pool, read) => {
      calls.push(`${name}:withReadTransaction`);
      const client = {
        query: async () => {
          calls.push(`${name}:query`);
          return { rows: [], rowCount: 0 };
        },
      } as unknown as ContextQueryClient;
      return read(client);
    },
    prepareReadDecisions: async () => {
      calls.push(`${name}:prepareReadDecisions`);
      await options.beforeReadDecisions?.();
      return {
        decide: async (_client, input) => {
          calls.push(`${name}:decide`);
          return Object.fromEntries(input.ids.map((id) => [id, { allowed: true }]));
        },
      };
    },
    viewerActionReadTime: () => {
      calls.push(`${name}:viewerActionReadTime`);
      throw new Error(`${name}:no read time`);
    },
    resourceAuthorization: () => {
      calls.push(`${name}:resourceAuthorization`);
      if (!options.resourceAuthorization) throw new Error(`${name}:no command authorization`);
      return options.resourceAuthorization();
    },
    initializeResourceGrants: async () => {
      calls.push(`${name}:initializeResourceGrants`);
    },
    createPublicEligibility: () => {
      calls.push(`${name}:createPublicEligibility`);
      return {};
    },
    readAccount: async () => {
      calls.push(`${name}:readAccount`);
      return { state: 'active', fenced: false };
    },
    requestInvalid: () => new Error(`${name}:invalid_request`),
    notFound: () => new Error(`${name}:not_found`),
    lifecycleDenied: () => new Error(`${name}:denied`),
    refreshErasureSourceRecord: async () => {
      calls.push(`${name}:refreshErasureSourceRecord`);
    },
    readSourceDisposition: async () => {
      calls.push(`${name}:readSourceDisposition`);
      return null;
    },
    recordSourceDisposition: () => {
      calls.push(`${name}:recordSourceDisposition`);
    },
    recordSourceCommit: async () => {
      calls.push(`${name}:recordSourceCommit`);
    },
  };
}

function restoreOrdinaryContextAccess() {
  bindContextAccess(composeSemanticContext().access);
}

test('nonempty Context metadata authorization uses its application port', async () => {
  const calls: string[] = [];
  const port = makePort('supplied', calls);
  const application = createContextApplication(port);
  bindContextAccess(makePort('global', calls));
  try {
    await expect(
      application.authorizedMetadata(
        { pool: {} as Pool, access: {} },
        { ids: [CONTEXT_GLOBAL_ID], actor: { kind: 'anonymous' }, deadline: Date.now() + 10_000 },
      ),
    ).rejects.toThrow('supplied:no read time');
    expect(calls).toContain('supplied:prepareReadDecisions');
    expect(calls).toContain('supplied:viewerActionReadTime');
    expect(calls).not.toContain('global:prepareReadDecisions');
  } finally {
    restoreOrdinaryContextAccess();
  }
});

test('lifecycle authorization uses the application port', async () => {
  const calls: string[] = [];
  const port = makePort('lifecycle', calls, {
    resourceAuthorization: () => {
      throw new Error('supplied lifecycle authorization');
    },
  });
  const application = createContextApplication(port);
  bindContextAccess({} as ContextAccessPort);
  try {
    await expect(
      application.changeLifecycle({} as Pool, {
        context: newId(16),
        state: 'deleted',
        actor: {
          kind: 'account',
          accountId: newId(1),
          clientId: 'client',
          scopes: [],
          requestedBy: null,
          authnEpoch: 1,
        },
        access: {},
        idempotencyKey: 'context-delete-key',
        digest: new Uint8Array(32),
        deadline: Date.now() + 10_000,
        clock: () => new Date('2026-11-07T00:00:00.000Z'),
      }),
    ).rejects.toThrow('supplied lifecycle authorization');
    expect(calls).toContain('lifecycle:resourceAuthorization');
  } finally {
    restoreOrdinaryContextAccess();
  }
});

test('two applications retain separate ports across interleaved nested authorization', async () => {
  const calls: string[] = [];
  let releaseA!: () => void;
  let releaseB!: () => void;
  const gateA = new Promise<void>((resolve) => (releaseA = resolve));
  const gateB = new Promise<void>((resolve) => (releaseB = resolve));
  const portA = makePort('app-a', calls, {
    beforeReadDecisions: () => gateA,
  });
  const portB = makePort('app-b', calls, {
    beforeReadDecisions: () => gateB,
  });
  const global = makePort('global', calls);
  const applicationA = createContextApplication(portA);
  const applicationB = createContextApplication(portB);
  bindContextAccess(global);
  try {
    const idA = newId(16);
    const idB = newId(32);
    const metadataA = applicationA.authorizedMetadata(
      { pool: {} as Pool, access: {} },
      { ids: [idA], actor: { kind: 'anonymous' }, deadline: Date.now() + 10_000 },
    );
    const metadataB = applicationB.authorizedMetadata(
      { pool: {} as Pool, access: {} },
      { ids: [idB], actor: { kind: 'anonymous' }, deadline: Date.now() + 10_000 },
    );
    const pendingA = Promise.allSettled([metadataA]);
    const pendingB = Promise.allSettled([metadataB]);
    releaseB();
    const [resultB] = await pendingB;
    releaseA();
    const [resultA] = await pendingA;
    expect(resultA.status).toBe('rejected');
    if (resultA.status === 'rejected') expect(resultA.reason).toHaveProperty('message', 'app-a:no read time');
    expect(resultB.status).toBe('rejected');
    if (resultB.status === 'rejected') expect(resultB.reason).toHaveProperty('message', 'app-b:no read time');
    expect(calls).toContain('app-a:prepareReadDecisions');
    expect(calls).toContain('app-b:prepareReadDecisions');
    expect(calls).toContain('app-a:viewerActionReadTime');
    expect(calls).toContain('app-b:viewerActionReadTime');
    expect(calls).not.toContain('global:prepareReadDecisions');
    expect(partitionOf(routeOf(idA)!)).not.toBe(partitionOf(routeOf(idB)!));
  } finally {
    restoreOrdinaryContextAccess();
  }
});

test('ordinary composition binds the native Context port', () => {
  const application = composeSemanticContext();
  expect(contextAccess()).toBe(application.access);
  expect(typeof application.createDirectory).toBe('function');
  expect(typeof application.enrollRoleProvenance).toBe('function');
  expect(typeof application.changeLifecycle).toBe('function');
});
