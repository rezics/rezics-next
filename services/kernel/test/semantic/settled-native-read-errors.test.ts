import { expect, spyOn, test } from 'bun:test';
import type { Pool, PoolClient, QueryConfig } from 'pg';
import { AccessUnavailableError, CommandUnavailableError } from '../../src/access/unavailable.ts';
import { AccessWorkAccounting } from '../../src/access/work.ts';
import type { Access } from '../../src/request/access.ts';
import { DefinitionAccessDeniedError } from '../../src/semantic/contract/definition-values.ts';
import { createNativeDefinitionCatalogue } from '../../src/semantic/definition-catalogue.ts';
import type { NativeIdentityCapabilities } from '../../src/semantic/identity-adapter-port.ts';
import { createIdentityReaders } from '../../src/semantic/identity-adapters/identity-epoch-read.ts';
import { withReadTransaction } from '../../src/semantic/read.ts';

type Consumer = 'catalogue' | 'identity';
type Row = Record<string, unknown>;
const unchanged = async (rows: Row[], _observation: number) => rows;

// Isolated pool double with the real read executor. Native receiver acceptance is separate.
function fixture(consumer: Consumer) {
  let now = Date.now();
  const deadline = now + 50;
  const clock = spyOn(Date, 'now').mockImplementation(() => now);
  const controls = {
    read: unchanged,
    authorize: async () => true,
    cleanup: () => {},
    commit: () => {},
    home: 'active',
  };
  let checkouts = 0;
  let observations = 0;
  const pool = {
    async connect() {
      checkouts++;
      let transaction = false;
      return {
        async query(input: string | (QueryConfig & { rowMode?: string })) {
          const config: QueryConfig & { rowMode?: string } = typeof input === 'string' ? { text: input } : input;
          const sql = config.text;
          let rows: Row[] = [];
          if (sql.startsWith('BEGIN')) transaction = true;
          else if (sql === 'ROLLBACK') controls.cleanup();
          else if (sql === 'COMMIT') controls.commit();
          else if (sql.startsWith('SET LOCAL')) {
            // The real executor retains its statement timeout setup.
          } else if (sql.includes('clock_timestamp()')) {
            const at = new Date(now).toISOString();
            rows = [{ at, databaseAt: at }];
          } else if (sql === 'SELECT write_state FROM core.partition WHERE partition_no=0') {
            rows = [{ write_state: controls.home }];
          } else if (sql.includes('FROM semantic.definition_catalogue_head')) {
            rows = await controls.read([{ root_digest: null, head: 1 }], ++observations);
          } else if (sql.includes('FROM semantic.identity_epoch_group')) {
            rows = await controls.read(
              Array.from({ length: 4096 }, (_, partition_no) => ({
                partition_no,
                epoch: 1,
                node: 'home',
                write_state: 'active',
                moved_to: null,
                generation: '1',
                pending: '0',
              })),
              ++observations,
            );
          } else throw new Error(`Unexpected isolated read: ${sql}`);
          return {
            rows: config.rowMode === 'array' ? rows.map(Object.values) : rows,
            rowCount: rows.length,
            command: 'SELECT',
            oid: 0,
            fields: [],
          };
        },
        release() {
          if (transaction) controls.cleanup();
        },
      } as unknown as PoolClient;
    },
  } as unknown as Pool;
  const access: Access = {
    authenticate: async () => {
      throw new Error('Unexpected authentication');
    },
    authorize: () => controls.authorize(),
  };
  const catalogue = createNativeDefinitionCatalogue({ pool, access });
  const identity = createIdentityReaders({
    read: { withReadTransaction, requestDeadline: () => deadline },
  } as NativeIdentityCapabilities);
  const read = (requestDeadline = deadline) =>
    consumer === 'catalogue'
      ? catalogue.head({
          actor: { kind: 'anonymous' },
          deadline: requestDeadline,
          work: new AccessWorkAccounting({ reserve: () => ({ settle() {} }) }, requestDeadline),
        })
      : identity.readIdentityBasis(pool, { deadline: requestDeadline });
  return {
    controls,
    read,
    deadline,
    checkouts: () => checkouts,
    expire: () => {
      now = deadline;
    },
    restore: () => clock.mockRestore(),
    async recover() {
      controls.read = unchanged;
      controls.authorize = async () => true;
      controls.cleanup = () => {};
      controls.commit = () => {};
      controls.home = 'active';
      const result = await read(now + 50);
      if (consumer === 'catalogue') expect(result).toBeNull();
      else
        expect(result).toEqual({ state: 'ready', basis: { digest: expect.stringMatching(/^[0-9a-f]{64}$/) } });
    },
  };
}

for (const failure of [new DefinitionAccessDeniedError(), new CommandUnavailableError('moved', 0)]) {
  test(`catalogue retains the exact ${failure.name} after cleanup expires`, async () => {
    const f = fixture('catalogue');
    try {
      f.controls.authorize = async () => {
        throw failure;
      };
      f.controls.cleanup = f.expire;
      await expect(f.read()).rejects.toBe(failure);
      expect(Date.now()).toBe(f.deadline);
      await f.recover();
    } finally {
      f.restore();
    }
  });
}

test('catalogue native moved and denied guards survive cleanup expiry', async () => {
  for (const guard of ['moved', 'denied']) {
    const f = fixture('catalogue');
    try {
      f.controls.home = guard === 'moved' ? 'moved' : 'active';
      f.controls.authorize = async () => false;
      f.controls.cleanup = f.expire;
      const error = await f.read().catch((error: unknown) => error);
      if (guard === 'moved') {
        expect(error).toBeInstanceOf(CommandUnavailableError);
        expect(error).toMatchObject({ reason: 'moved' });
      } else expect(error).toBeInstanceOf(DefinitionAccessDeniedError);
      expect(Date.now()).toBe(f.deadline);
      await f.recover();
    } finally {
      f.restore();
    }
  }
});

for (const consumer of ['catalogue', 'identity'] as const) {
  for (const observation of consumer === 'identity' ? [1, 2] : [1]) {
    for (const kind of ['sql', 'decode', 'contention', 'overloaded', 'deadline'] as const) {
      test(`${consumer} observation ${observation} retains ${kind} through cleanup expiry`, async () => {
        const f = fixture(consumer);
        const reason = kind === 'contention' || kind === 'overloaded' || kind === 'deadline' ? kind : undefined;
        const failure =
          kind === 'decode'
            ? new SyntaxError('Invalid native value')
            : Object.assign(new Error('Native statement failed'), {
                code: { sql: '23514', contention: '40001', overloaded: '53300', deadline: '57014' }[kind],
                severity: 'ERROR',
              });
        try {
          f.controls.read = async (rows, current) => {
            if (current !== observation) return rows;
            if (kind !== 'decode') throw failure;
            Object.defineProperty(rows[0]!, consumer === 'catalogue' ? 'root_digest' : 'generation', {
              get() {
                throw failure;
              },
            });
            return rows;
          };
          f.controls.cleanup = f.expire;
          if (reason) {
            const error = await f.read().catch((error: unknown) => error);
            expect(error).toBeInstanceOf(AccessUnavailableError);
            expect(error).toMatchObject({ reason });
          } else await expect(f.read()).rejects.toBe(failure);
          expect(Date.now()).toBe(f.deadline);
          await f.recover();
        } finally {
          f.restore();
        }
      });
    }
  }

  test(`${consumer} keeps preflight and successful-result expiry`, async () => {
    const f = fixture(consumer);
    try {
      await expect(f.read(Date.now())).rejects.toMatchObject({ reason: 'deadline' });
      expect(f.checkouts()).toBe(0);
      f.controls.commit = f.expire;
      await expect(f.read()).rejects.toMatchObject({ reason: 'deadline' });
      await f.recover();
    } finally {
      f.restore();
    }
  });

  test(`${consumer} keeps a timer victory over a later native failure and recovers`, async () => {
    const f = fixture(consumer);
    let rejectLate!: (error: unknown) => void;
    const pending = new Promise<Row[]>((_resolve, reject) => {
      rejectLate = reject;
    });
    const late = Object.assign(new Error('Statement failed after the timer'), { code: '23514', severity: 'ERROR' });
    try {
      f.controls.read = () => {
        f.expire();
        return pending;
      };
      const error = await f.read().catch((error: unknown) => error);
      expect(error).toBeInstanceOf(AccessUnavailableError);
      expect(error).toMatchObject({ reason: 'deadline' });
      rejectLate(late);
      await f.recover();
    } finally {
      rejectLate(late);
      await pending.catch(() => {});
      f.restore();
    }
  });
}

test('identity basis retains missing, pending and changed currentness with later readiness', async () => {
  for (const state of ['missing', 'pending', 'changed']) {
    const f = fixture('identity');
    try {
      f.controls.read = async (rows, observation) => {
        if (state === 'missing') rows.pop();
        if (state === 'pending') rows[0]!.pending = '1';
        if (state === 'changed' && observation === 2) rows[0]!.generation = '2';
        return rows;
      };
      await expect(f.read()).resolves.toEqual({ state: 'not_ready' });
      await f.recover();
    } finally {
      f.restore();
    }
  }
});
