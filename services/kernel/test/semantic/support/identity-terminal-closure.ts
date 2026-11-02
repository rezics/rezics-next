import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { runCommand } from '../../../src/command/command.ts';
import {
  admitIdentityTerminalCapture,
  runIdentityTerminalCommand,
} from '../../../src/semantic/identity-terminal-closure-command.ts';
import { createPool } from '../../../src/database/pool.ts';
import { routeOf } from '../../../src/route/route.ts';
import { IDENTITY_EPOCH_PROGRESS } from '../../../src/semantic/events.ts';
import { installIdentityEpochBootstrap } from '../../../src/semantic/identity-epoch-bootstrap-install.ts';
import { stepIdentityEpochBootstrap } from '../../../src/semantic/identity-epoch-bootstrap.ts';
import { readIdentityMappings } from '../../../src/semantic/identity-epoch-read.ts';
import { home, identityEpochDatabase, seedLegacyRoot } from './identity-epoch.ts';

export type Deployment = Awaited<ReturnType<typeof identityEpochDatabase>>;
export type Boundary =
  | 'export'
  | 'hold'
  | 'receive'
  | 'install'
  | 'promote'
  | 'ack'
  | 'withdraw'
  | 'close'
  | 'claim-release';
const boundarySQL: Record<Boundary, RegExp> = {
  export: /INSERT INTO semantic\.identity_epoch_bootstrap_page\b/,
  hold: /SET closure_successor_ticket=\$3/,
  receive: /INSERT INTO semantic\.identity_epoch_original\(partition_no,generation,original,terminal,/,
  install: /SET closure_state='installed',terminal=\$3/,
  promote: /UPDATE semantic\.identity_epoch_original SET closure_state='installed'/,
  ack: /SET closure_state='active',closure_ack_transaction=/,
  withdraw: /SET source_revision=\$5,closure_state='withdrawn'/,
  close: /SET closure_state='closing',closure_claim=/,
  'claim-release': /SET closure_claim=NULL,closure_mutation_xid=NULL/,
};

/** Historical input only: no mapping, ready bit, source ACK or custody is seeded. */
export async function seedChain(db: Deployment, length: number, firstRoute = 0x7100, homes = 3) {
  const ids: string[] = [];
  for (let index = 0; index <= length; index++) ids.push(await seedLegacyRoot(db, firstRoute + (index % homes) * 16));
  for (let index = 0; index < length; index++) await historicalEdge(db, ids[index]!, ids[index + 1]!);
  return ids;
}

export async function historicalEdge(db: Deployment, original: string, target: string) {
  await db.admin.query(
    `INSERT INTO semantic.redirect(route,subject_id,sequence,target,recorded_transaction_id)
     SELECT $1,$2,coalesce(max(sequence),0)+1,$3,$4 FROM semantic.redirect
     WHERE route=$1 AND subject_id=$2`,
    [routeOf(original), original, target, randomUUID()],
  );
}

/** A separate real native writer can race a checked-out receiving/source command. */
export async function appendEdge(db: Deployment, original: string, target: string) {
  const writer = createPool(db.url);
  try {
    await runIdentityTerminalCommand(writer, { partition: home(original) }, async (tx, { transactionId }) => {
      await admitIdentityTerminalCapture(tx, [original]);
      await tx.query(
        `INSERT INTO semantic.redirect(route,subject_id,sequence,target,recorded_transaction_id)
         SELECT $1,$2,coalesce(max(sequence),0)+1,$3,$4 FROM semantic.redirect
         WHERE route=$1 AND subject_id=$2`,
        [routeOf(original), original, target, transactionId],
      );
      return {
        value: null,
        events: [{ type: IDENTITY_EPOCH_PROGRESS, data: { partition: home(original), generation: '1' } }],
      };
    });
  } finally {
    await writer.end();
  }
}

export async function appendMember(db: Deployment, terminal: string, member: string) {
  const writer = createPool(db.url);
  try {
    await runIdentityTerminalCommand(writer, { partition: home(terminal) }, async (tx) => {
      await admitIdentityTerminalCapture(tx, [terminal]);
      await tx.query(
        `INSERT INTO semantic.merge_member(route,subject_id,member_id,phase,cursor)
         VALUES($1,$2,$3,'done','[]'::jsonb)`,
        [routeOf(terminal), terminal, member],
      );
      return {
        value: null,
        events: [{ type: IDENTITY_EPOCH_PROGRESS, data: { partition: home(terminal), generation: '1' } }],
      };
    });
  } finally {
    await writer.end();
  }
}

export async function sourceHead(db: Deployment, original: string) {
  return (
    await db.admin.query<{ revision: string; captured_revision: string }>(
      'SELECT revision::text,captured_revision::text FROM semantic.identity_epoch_dirty WHERE route=$1 AND original=$2',
      [routeOf(original), original],
    )
  ).rows[0]!;
}

export async function retainedPage(db: Deployment, original: string) {
  return (
    await db.admin.query<{ generation: string; transaction_id: string; acknowledged: boolean }>(
      `SELECT p.generation::text,p.transaction_id::text,p.acknowledged
       FROM semantic.identity_epoch_bootstrap_page p
       WHERE p.partition_no=$1 ORDER BY p.generation DESC LIMIT 1`,
      [home(original)],
    )
  ).rows[0];
}

export async function assertRetained(db: Deployment, original: string) {
  const page = await retainedPage(db, original);
  expect(page).toBeDefined();
  // Transport ACK can transfer a page to its native source header without
  // acknowledging h. Either retained body must own this unfinished original.
  const custody = (
    await db.admin.query(
      `SELECT 1 FROM semantic.identity_epoch_bootstrap_row
    WHERE partition_no=$1 AND original=$2 UNION ALL
    SELECT 1 FROM semantic.identity_epoch_mapping WHERE route/16=$1 AND original=$2
      AND closure_state IN ('exporting','installed','withdrawn')`,
      [home(original), original],
    )
  ).rows;
  expect(custody.length).toBeGreaterThan(0);
  expect((await readIdentityMappings(db.pool, [original]))[0]?.state).not.toBe('mapped');
  return page!;
}

export async function settle(db: Deployment, ids: readonly string[], original = ids[0]!, rounds = 64) {
  const homes = [...new Set([...ids].reverse().map(home))];
  let observed = (await readIdentityMappings(db.pool, [original]))[0]!;
  let steps = 0;
  for (let round = 0; round < rounds && observed.state !== 'mapped'; round++) {
    for (const partition of homes) {
      const progress = await stepIdentityEpochBootstrap(db.pool, partition);
      expect(progress.work.rows).toBeLessThanOrEqual(100);
      expect(progress.native.partition).toBe(partition);
      expect(progress.work.statements).toBeGreaterThan(0);
      steps++;
    }
    observed = (await readIdentityMappings(db.pool, [original]))[0]!;
  }
  return { observed, steps };
}

/** Interpose at a real statement or after its real COMMIT; never substitute SQL results. */
export async function atBoundary<T>(
  db: Deployment,
  boundary: Boundary,
  when: 'before' | 'after-commit',
  action: () => Promise<void>,
  operation: () => Promise<T>,
  sourcePartition?: number,
  original?: string,
) {
  const saved = new Map<PoolClient, PoolClient['query']>();
  let fired = false;
  const acquire = (client: PoolClient) => {
    if (saved.has(client)) return;
    const query = client.query;
    saved.set(client, query);
    let matched = false;
    client.query = async function (...args: unknown[]) {
      const sql = typeof args[0] === 'string' ? args[0] : ((args[0] as { text?: string })?.text ?? '');
      if (/^BEGIN\b/.test(sql)) matched = false;
      const parameters = args[1] as unknown[] | undefined;
      const nativePartition =
        boundary === 'install' ||
        boundary === 'ack' ||
        boundary === 'hold' ||
        boundary === 'withdraw' ||
        boundary === 'claim-release'
          ? Math.floor(Number(parameters?.[0]) / 16)
          : parameters?.[0];
      const matchesSource =
        (sourcePartition === undefined || nativePartition === sourcePartition) &&
        (original === undefined || parameters?.includes(original));
      if (!fired && matchesSource && boundarySQL[boundary].test(sql)) {
        matched = true;
        if (when === 'before') {
          fired = true;
          await action();
        }
      }
      const result = await Reflect.apply(query, client, args);
      if (!fired && matched && sql === 'COMMIT' && when === 'after-commit') {
        fired = true;
        await action();
      }
      return result;
    } as PoolClient['query'];
  };
  db.pool.on('acquire', acquire);
  try {
    return await operation();
  } finally {
    db.pool.off('acquire', acquire);
    for (const [client, query] of saved) client.query = query;
    expect(fired, `native ${boundary} boundary must actually execute`).toBe(true);
  }
}

/** PostgreSQL, including nested functions, enforces one home per transaction.
 * The role has no owner/superuser/RLS bypass; each BEGIN must bind a new home.
 */
export async function isolatedDeployment() {
  const db = await identityEpochDatabase();
  const role = `terminal_home_${randomUUID().replaceAll('-', '')}`;
  const tables: { schema: string; name: string; key: string }[] = [];
  const saved = new Map<PoolClient, PoolClient['query']>();
  let enforcedTransactions = 0;
  const acquire = (client: PoolClient) => {
    if (saved.has(client)) return;
    const query = client.query;
    saved.set(client, query);
    let bound = false;
    client.query = async function (...args: unknown[]) {
      const sql = typeof args[0] === 'string' ? args[0] : ((args[0] as { text?: string })?.text ?? '');
      if (/^BEGIN\b/.test(sql)) bound = false;
      if (!bound && /(?:core\.partition|semantic\.identity_epoch_)/.test(sql)) {
        const parameters = args[1] as unknown[] | undefined;
        const first = parameters?.[0];
        const partition = Array.isArray(first) ? first[0] : first;
        if (typeof partition !== 'number' || partition < 0 || partition > 4095)
          throw new Error('Native transaction did not identify its home before protected access');
        if (Array.isArray(first)) expect(new Set(first).size).toBe(1);
        await Reflect.apply(query, client, [`SET LOCAL ROLE ${role}`]);
        await Reflect.apply(query, client, ["SELECT set_config('terminal_test.home',$1,true)", [String(partition)]]);
        bound = true;
        enforcedTransactions++;
      }
      return Reflect.apply(query, client, args);
    } as PoolClient['query'];
  };
  return {
    ...db,
    async install() {
      expect((await installIdentityEpochBootstrap(db.pool)).mode).toBe('legacy');
      await db.admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
      await db.admin.query(`GRANT USAGE ON SCHEMA semantic,core,editorial TO ${role}`);
      await db.admin.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA semantic,core TO ${role}`);
      await db.admin.query(`GRANT SELECT,INSERT ON editorial.write_basis TO ${role}`);
      await db.admin.query(`GRANT USAGE ON ALL SEQUENCES IN SCHEMA semantic,core TO ${role}`);
      const protectedTables = (
        await db.admin.query<{ schema: string; name: string; key: string }>(`
          SELECT n.nspname schema,c.relname name,
            CASE WHEN EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='partition_no')
              THEN 'partition_no' ELSE 'route / 16' END key
          FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE c.relkind='r' AND (
            (n.nspname='semantic' AND (c.relname LIKE 'identity_epoch_%'
              OR c.relname LIKE 'identity_terminal_closure%' OR c.relname IN ('subject','redirect','merge_member')))
            OR (n.nspname='core' AND c.relname='partition'))
            AND EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname IN ('route','partition_no'))
          ORDER BY n.nspname,c.relname
        `)
      ).rows;
      for (const table of protectedTables) {
        await db.admin.query(`ALTER TABLE ${table.schema}.${table.name} ENABLE ROW LEVEL SECURITY`);
        await db.admin.query(`CREATE POLICY terminal_native_home ON ${table.schema}.${table.name} TO ${role}
          USING (${table.key}=current_setting('terminal_test.home')::integer)
          WITH CHECK (${table.key}=current_setting('terminal_test.home')::integer)`);
        tables.push(table);
      }
      db.pool.on('acquire', acquire);
    },
    async close() {
      db.pool.off('acquire', acquire);
      for (const [client, query] of saved) client.query = query;
      try {
        if (tables.length) {
          expect(enforcedTransactions).toBeGreaterThan(0);
          for (const table of tables.reverse()) {
            await db.admin.query(`DROP POLICY terminal_native_home ON ${table.schema}.${table.name}`);
            await db.admin.query(`ALTER TABLE ${table.schema}.${table.name} DISABLE ROW LEVEL SECURITY`);
          }
          await db.admin.query(`DROP OWNED BY ${role}`);
          await db.admin.query(`DROP ROLE ${role}`);
        }
      } finally {
        await db.close();
      }
    },
  };
}
