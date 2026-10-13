import { Client } from 'pg';
import { startPostgresCluster } from '../support/postgres-cluster.ts';
import { expect, test } from 'bun:test';
import { cloneQaOwnerDatabases, type QaCloneSession, type QaCloneSources, type QaDatabaseOwner }
  from '../support/databases.ts';

const ownerUrls: Record<QaDatabaseOwner, string> = {
  account: 'postgres://account:secret@127.0.0.1:5432/account',
  access: 'postgres://access:secret@127.0.0.1:5432/access',
  content: 'postgres://content:secret@127.0.0.1:5432/content',
  relay: 'postgres://relay:secret@127.0.0.1:5432/relay',
};

function sources(failCreateAt?: number): QaCloneSources & { sessions: { queries: string[]; ended: boolean }[] } {
  const sessions: { queries: string[]; ended: boolean }[] = [];
  let creates = 0;
  return {
    sessions,
    suffix: 'abc123',
    adminUrl: 'postgres://postgres:secret@127.0.0.1:5432/postgres',
    ownerUrls,
    connect: async (): Promise<QaCloneSession> => {
      const session = { queries: [] as string[], ended: false };
      sessions.push(session);
      return {
        query: async sql => {
          session.queries.push(sql);
          if (sql.startsWith('CREATE DATABASE') && failCreateAt !== undefined && ++creates === failCreateAt) {
            throw new Error('create failed');
          }
        },
        end: async () => { session.ended = true; },
      };
    },
  };
}

test('a failed second owner-template create drops the first clone', async () => {
  const fake = sources(2);
  await expect(cloneQaOwnerDatabases('qa-run', ['access', 'content'], 'owner', fake)).rejects.toThrow('create failed');
  const sql = fake.sessions[0]!.queries;
  expect(sql[0]).toBe('CREATE DATABASE qa_abc123_access WITH TEMPLATE access_tpl OWNER access');
  expect(sql[1]).toBe('CREATE DATABASE qa_abc123_content WITH TEMPLATE content_tpl OWNER content');
  expect(sql[2]).toContain('ALTER DATABASE qa_abc123_access ALLOW_CONNECTIONS false');
  expect(sql[4]).toBe('DROP DATABASE IF EXISTS qa_abc123_access');
  expect(sql.some(query => query.includes('FORCE'))).toBe(false);
  expect(sql.some(query => query.includes('qa_abc123_content') && query.startsWith('DROP'))).toBe(false);
  expect(fake.sessions[0]!.ended).toBe(true);
});

test('owner-role clones connect as the template role', async () => {
  const accountAccess = sources();
  const fixed = await cloneQaOwnerDatabases('qa-run', ['account', 'access'], 'owner', accountAccess);
  expect(new URL(fixed.urls.account).username).toBe('account');
  expect(new URL(fixed.urls.access).username).toBe('access');
  expect(accountAccess.sessions[0]!.queries[0]).toContain('OWNER account');
  await fixed.close();

  const selected = sources();
  const fences = await cloneQaOwnerDatabases('qa-run', ['access', 'content'], 'owner', selected);
  expect(new URL(fences.urls.access).username).toBe('access');
  expect(new URL(fences.urls.content).username).toBe('content');
  expect(selected.sessions[0]!.queries.every(query => query.includes('OWNER'))).toBe(true);
  await fences.close();
});

test('privileged clones connect as the database superuser', async () => {
  const fake = sources();
  const clones = await cloneQaOwnerDatabases('qa-run', ['access', 'content', 'relay'], 'privileged', fake);
  expect(new URL(clones.urls.access).username).toBe('postgres');
  expect(new URL(clones.urls.content).username).toBe('postgres');
  expect(new URL(clones.urls.relay).username).toBe('postgres');
  expect(fake.sessions[0]!.queries.every(query => !query.includes('OWNER'))).toBe(true);
  expect(fake.sessions[0]!.queries[0]).toBe('CREATE DATABASE qa_abc123_access WITH TEMPLATE access_tpl');
  await clones.close();
});

test('a snapshot keeps the clone connection role and close drops it after the clone', async () => {
  const owner = sources();
  const clones = await cloneQaOwnerDatabases('qa-run', ['access'], 'owner', owner);
  let closed = false;
  const snapshot = await clones.snapshot('access', async () => { closed = true; });
  expect(closed).toBe(true);
  expect(new URL(snapshot).username).toBe('access');
  expect(owner.sessions[1]!.queries[0]).toBe(
    'CREATE DATABASE qa_abc123_access_s1 WITH TEMPLATE qa_abc123_access OWNER access');
  await clones.close();
  expect(owner.sessions[2]!.queries.filter(sql => sql.startsWith('DROP'))).toEqual([
    'DROP DATABASE IF EXISTS qa_abc123_access_s1',
    'DROP DATABASE IF EXISTS qa_abc123_access',
  ]);

  const privileged = sources();
  const superuser = await cloneQaOwnerDatabases('qa-run', ['account'], 'privileged', privileged);
  const copy = await superuser.snapshot('account', async () => {});
  expect(new URL(copy).username).toBe('postgres');
  expect(privileged.sessions[1]!.queries[0]).toBe(
    'CREATE DATABASE qa_abc123_account_s1 WITH TEMPLATE qa_abc123_account');
  await superuser.close();
});

test('a clone run id must be a stack id', async () => {
  await expect(cloneQaOwnerDatabases('Bad Run', ['access'], 'owner', sources())).rejects.toThrow('valid run');
});


test('removing a clone waits for its clients and preserves a neighbouring client and listener', async () => {
  const cluster = await startPostgresCluster();
  const adminUrl = `postgres://${cluster.user}@127.0.0.1:${cluster.port}/postgres`;
  const admin = new Client({ connectionString: adminUrl });
  const clients: Client[] = [];
  let first: Awaited<ReturnType<typeof cloneQaOwnerDatabases>> | undefined;
  let second: typeof first;
  try {
    await admin.connect();
    await admin.query('CREATE DATABASE relay_tpl');
    const realSources = (suffix: string): QaCloneSources => ({
      suffix, adminUrl, ownerUrls: {},
      connect: async url => {
        const client = new Client({ connectionString: url });
        await client.connect();
        return { query: sql => client.query(sql), end: () => client.end() };
      },
    });
    first = await cloneQaOwnerDatabases('qa-run', ['relay'], 'privileged', realSources('first'));
    second = await cloneQaOwnerDatabases('qa-run', ['relay'], 'privileged', realSources('second'));
    const own = new Client({ connectionString: first.urls.relay });
    const neighbour = new Client({ connectionString: second.urls.relay });
    const listener = new Client({ connectionString: second.urls.relay });
    clients.push(own, neighbour, listener);
    const errors: Error[] = [];
    for (const client of clients) { client.on('error', error => errors.push(error)); await client.connect(); }
    await listener.query('LISTEN clone_cleanup');
    let removed = false;
    const removal = first.close().then(() => { removed = true; });
    // Observe a sleeping cleanup loop while the first clone still has its own client.
    for (let turn = 0; turn < 100; turn++) {
      const state = await admin.query(`SELECT EXISTS (SELECT 1 FROM pg_stat_activity
        WHERE query LIKE 'DO $$ DECLARE deadline%' AND query LIKE '%qa_first_relay%'
          AND wait_event = 'PgSleep') AS waiting`);
      if (state.rows[0]?.waiting === true) break;
      if (turn === 99) throw new Error('clone cleanup did not fence new clients');
      await Bun.sleep(10);
    }
    expect(removed).toBe(false);
    expect((await own.query('SELECT 1 AS value')).rows[0].value).toBe(1);
    await own.end();
    await removal;
    await first.close(); // Cleanup remains safe when a finally block repeats it.
    first = undefined;
    expect((await neighbour.query('SELECT 2 AS value')).rows[0].value).toBe(2);
    const notification = new Promise<string | undefined>(resolve => listener.once('notification', event => resolve(event.payload)));
    await neighbour.query("NOTIFY clone_cleanup, 'still working'");
    expect(await notification).toBe('still working');
    expect(errors).toEqual([]);
  } finally {
    await Promise.all(clients.map(client => client.end()));
    await first?.close();
    await second?.close();
    await admin.end();
    cluster.remove();
  }
}, 30_000);
