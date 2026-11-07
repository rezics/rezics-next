import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { mintReadTime } from '../../src/command/command.ts';
import { composeSemanticContext } from '../../src/composition/semantic-context.ts';
import {
  bindContextAccess,
  CONTEXT_GLOBAL_ID,
  contextAccess,
  type ContextAccessPort,
  type ContextQueryClient,
  unbindContextAccess,
} from '../../src/semantic/context-access-port.ts';
import { createContextApplication } from '../../src/semantic/context-application.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';

type QueryResult = { rows: Record<string, unknown>[]; rowCount: number };
type PortOptions = {
  query?: (sql: string, values?: unknown[]) => QueryResult;
  readTime?: Awaited<ReturnType<typeof mintReadTime>>;
  readAccount?: (route: number, accountId: string) => Promise<{ state: string; fenced: boolean } | null>;
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
      const client: ContextQueryClient = {
        query: async (sql: string, values?: unknown[]) => {
          calls.push(`${name}:query`);
          return options.query?.(sql, values) ?? { rows: [], rowCount: 0 };
        },
      };
      return read(client);
    },
    prepareReadDecisions: async () => {
      calls.push(`${name}:prepareReadDecisions`);
      return {
        decide: async (_client, input) => {
          calls.push(`${name}:decide`);
          return Object.fromEntries(input.ids.map((id) => [id, { allowed: true }]));
        },
      };
    },
    viewerActionReadTime: () => {
      calls.push(`${name}:viewerActionReadTime`);
      if (!options.readTime) throw new Error(`${name}:no read time`);
      return options.readTime;
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
    readAccount: async (client, route, accountId) => {
      calls.push(`${name}:readAccount`);
      return options.readAccount?.(route, accountId) ?? { state: 'active', fenced: false };
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

function directoryQuery(sql: string): QueryResult {
  if (sql.includes('FROM core.partition'))
    return {
      rows: [{ partitionNo: 0, node: 'native', writeState: 'active', movedTo: null, epoch: 1, position: '0' }],
      rowCount: 1,
    };
  if (sql.includes('FROM semantic.context_directory_home')) return { rows: [], rowCount: 0 };
  if (sql.includes('FROM semantic.context_directory_entry') && sql.includes('search_key >='))
    return {
      rows: [{ id: CONTEXT_GLOBAL_ID, key: 'global context', language: 'en', version: '1', source_epoch: 1 }],
      rowCount: 1,
    };
  if (sql.includes('FROM semantic.context') && sql.includes('security_revision::text AS version'))
    return {
      rows: [
        {
          id: CONTEXT_GLOBAL_ID,
          kind: 'global',
          labels: { en: 'Global Context' },
          state: 'active',
          deletedAt: null,
          purgeAfter: null,
          version: '1',
        },
      ],
      rowCount: 1,
    };
  if (sql.includes('FROM access.resource_role_grant')) return { rows: [], rowCount: 0 };
  if (sql.includes('AS restorable'))
    return {
      rows: [{ id: CONTEXT_GLOBAL_ID, kind: 'global', state: 'active', restorable: false, owner: false }],
      rowCount: 1,
    };
  if (sql.includes('SELECT context_id::text AS id,security_revision::text AS version'))
    return { rows: [{ id: CONTEXT_GLOBAL_ID, version: '1' }], rowCount: 1 };
  return { rows: [], rowCount: 0 };
}

function contextReaderQuery(sql: string, values: unknown[] | undefined): QueryResult {
  if (sql.includes('FROM core.partition')) {
    const partitionNo = Number(values?.[0] ?? 0);
    return {
      rows: [{ partitionNo, node: 'native', writeState: 'active', movedTo: null, epoch: 1, position: '0' }],
      rowCount: 1,
    };
  }
  if (sql.includes('FROM semantic.context') && sql.includes("state = 'active'")) {
    const route = Number(values?.[0]);
    const id = String(values?.[1]);
    return {
      rows: [
        {
          id,
          kind: 'community',
          labels: { en: `Context ${route}` },
          settings_id: null,
          settings_release: null,
          defaults: {},
          recorded_transaction_id: null,
        },
      ],
      rowCount: 1,
    };
  }
  if (sql.includes('FROM access.resource_role_grant') && sql.includes('AS "accountId"'))
    return { rows: [{ accountId: newId(1) }], rowCount: 1 };
  return { rows: [], rowCount: 0 };
}

function dependencies() {
  return {
    pool: {} as Pool,
    access: {},
    tokens: { current: 1, keys: new Map([[1, new Uint8Array(32)]]) },
    clock: () => new Date('2026-11-07T00:00:00.000Z'),
  };
}

test('directory metadata stays on its application port through nested authorization', async () => {
  const calls: string[] = [];
  const readTime = await mintReadTime(
    { query: async () => ({ rows: [{ at: '2026-11-07T00:00:00.000Z' }] }) } as never,
    () => new Date('2026-11-07T00:00:00.000Z'),
  );
  const port = makePort('supplied', calls, { query: (sql) => directoryQuery(sql), readTime });
  const application = createContextApplication(port);
  bindContextAccess({} as ContextAccessPort);
  try {
    const page = await application.list(dependencies(), {
      actor: { kind: 'anonymous' },
      deadline: Date.now() + 10_000,
      query: 'glob',
    });
    expect(page).toEqual({
      contexts: [
        {
          id: CONTEXT_GLOBAL_ID,
          kind: 'global',
          labels: { en: 'Global Context' },
          state: 'active',
          deletedAt: null,
          purgeAfter: null,
        },
      ],
      next: null,
    });
    expect(calls).toContain('supplied:prepareReadDecisions');
    expect(calls).toContain('supplied:decide');
    expect(calls).toContain('supplied:requireDeadline');
  } finally {
    unbindContextAccess();
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
    unbindContextAccess();
  }
});

test('two applications retain separate ports through interleaved nested reads', async () => {
  const calls: string[] = [];
  let releaseA!: () => void;
  let releaseB!: () => void;
  const gateA = new Promise<void>((resolve) => (releaseA = resolve));
  const gateB = new Promise<void>((resolve) => (releaseB = resolve));
  const account = async () => ({ state: 'active', fenced: false });
  const portA = makePort('app-a', calls, {
    query: contextReaderQuery,
    readAccount: async () => {
      calls.push('app-a:nested-account');
      await gateA;
      return account();
    },
  });
  const portB = makePort('app-b', calls, {
    query: contextReaderQuery,
    readAccount: async () => {
      calls.push('app-b:nested-account');
      await gateB;
      return account();
    },
  });
  const global = makePort('global', calls, { query: contextReaderQuery });
  const applicationA = createContextApplication(portA);
  const applicationB = createContextApplication(portB);
  bindContextAccess(global);
  try {
    const idA = newId(16);
    const idB = newId(32);
    const readA = applicationA.read({} as Pool, idA, async () => true);
    const readB = applicationB.read({} as Pool, idB, async () => true);
    releaseB();
    const resultB = await readB;
    releaseA();
    const resultA = await readA;
    expect(resultA?.context.id).toBe(idA);
    expect(resultB?.context.id).toBe(idB);
    expect(calls).toContain('app-a:nested-account');
    expect(calls).toContain('app-b:nested-account');
    expect(calls).not.toContain('global:readAccount');
    expect(partitionOf(routeOf(idA)!)).not.toBe(partitionOf(routeOf(idB)!));
  } finally {
    unbindContextAccess();
  }
});

test('ordinary composition binds the native Context port', () => {
  const application = composeSemanticContext();
  expect(contextAccess()).toBe(application.access);
  expect(typeof application.createDirectory).toBe('function');
  expect(typeof application.enrollRoleProvenance).toBe('function');
  expect(typeof application.changeLifecycle).toBe('function');
});
