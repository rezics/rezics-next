import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { Client } from 'pg';
import { readEnv } from '../../../scripts/dev/config.ts';

export type QaDatabaseOwner = 'account' | 'access' | 'content' | 'relay';
/** `owner` logs in as the template role. `privileged` logs in as the database superuser. */
export type QaDatabaseConnection = 'owner' | 'privileged';

const ownerUrlKey: Record<QaDatabaseOwner, string> = {
  account: 'ACCOUNT_DATABASE_URL',
  access: 'ACCESS_DATABASE_URL',
  content: 'CONTENT_DATABASE_URL',
  relay: 'ACCOUNT_RELAY_DATABASE_URL',
};

export interface QaCloneSession {
  query(sql: string): Promise<unknown>;
  end(): Promise<void>;
}

/** Stack lookup replacement so a test can fail a create without PostgreSQL. */
export interface QaCloneSources {
  suffix: string;
  adminUrl: string;
  ownerUrls: Partial<Record<QaDatabaseOwner, string>>;
  connect(url: string): Promise<QaCloneSession>;
}

export interface QaOwnerClones {
  urls: Record<QaDatabaseOwner, string>;
  /** Point-in-time copy of an isolated owner database, as a restored backup. */
  snapshot: (owner: QaDatabaseOwner, closeConnections: () => Promise<void>) => Promise<string>;
  close: () => Promise<void>;
}

/**
 * Isolated copies of the migrated QA owner templates.
 * A later create that fails drops the clones already allocated.
 */
export async function cloneQaOwnerDatabases(
  runId: string,
  owners: readonly QaDatabaseOwner[],
  connection: QaDatabaseConnection,
  sources?: QaCloneSources,
): Promise<QaOwnerClones> {
  if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(runId)) throw new Error('QA database clones require a valid run');
  if (owners.length === 0 || owners.some(owner => !Object.hasOwn(ownerUrlKey, owner))) {
    throw new Error('QA database clones require an owner template');
  }
  const resolved = sources ?? stackSources(runId);
  if (!/^[a-z0-9]+$/.test(resolved.suffix)) throw new Error('QA database clones require a safe name');
  if (connection === 'owner') {
    for (const owner of owners) {
      if (!resolved.ownerUrls[owner]) throw new Error(`QA database clones require ${ownerUrlKey[owner]}`);
    }
  }
  return cloneFrom(owners, connection, resolved);
}

function stackSources(runId: string): QaCloneSources {
  const root = resolve(import.meta.dir, '../../..');
  const stackDir = join(root, '.temp', 'stack', `rezics-qa-${runId}`);
  const compose = readEnv(join(stackDir, 'compose.env'));
  const apps = readEnv(join(stackDir, 'apps.env'));
  const password = compose.POSTGRES_PASSWORD;
  const port = compose.POSTGRES_PORT;
  if (!password || !port) throw new Error('QA database clones require the stack admin connection');
  const ownerUrls: Partial<Record<QaDatabaseOwner, string>> = {};
  for (const owner of Object.keys(ownerUrlKey) as QaDatabaseOwner[]) {
    const url = apps[ownerUrlKey[owner]];
    if (url) ownerUrls[owner] = url;
  }
  return {
    suffix: randomBytes(6).toString('hex'),
    adminUrl: `postgres://postgres:${encodeURIComponent(password)}@127.0.0.1:${port}/postgres`,
    ownerUrls,
    connect: async url => {
      const client = new Client({ connectionString: url });
      await client.connect();
      return { query: sql => client.query(sql), end: () => client.end() };
    },
  };
}

function databaseUrl(base: string, name: string): string {
  const url = new URL(base);
  url.pathname = `/${name}`;
  return url.toString();
}

function createClone(name: string, owner: QaDatabaseOwner, connection: QaDatabaseConnection): string {
  const ownership = connection === 'owner' ? ` OWNER ${owner}` : '';
  return `CREATE DATABASE ${name} WITH TEMPLATE ${owner}_tpl${ownership}`;
}

async function dropClones(session: QaCloneSession, names: readonly string[]): Promise<void> {
  const failures: unknown[] = [];
  for (const name of [...names].reverse()) {
    try {
      await session.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, 'QA database clone cleanup failed');
}

async function cloneFrom(
  owners: readonly QaDatabaseOwner[],
  connection: QaDatabaseConnection,
  sources: QaCloneSources,
): Promise<QaOwnerClones> {
  const created: string[] = [];
  const names = {} as Record<QaDatabaseOwner, string>;
  const urls = {} as Record<QaDatabaseOwner, string>;
  const baseFor = (owner: QaDatabaseOwner) => connection === 'owner' ? sources.ownerUrls[owner]! : sources.adminUrl;
  const session = await sources.connect(sources.adminUrl);
  try {
    for (const owner of owners) {
      const name = `qa_${sources.suffix}_${owner}`;
      try {
        await session.query(createClone(name, owner, connection));
      } catch (error) {
        // CREATE DATABASE commits itself, so a failed later create would leave the earlier clone allocated.
        try { await dropClones(session, created); }
        catch (cleanup) { throw new AggregateError([error, cleanup], 'QA owner-template clone failed'); }
        throw error;
      }
      created.push(name);
      names[owner] = name;
      urls[owner] = databaseUrl(baseFor(owner), name);
    }
  } finally { await session.end(); }
  let snapshots = 0;
  return {
    urls,
    snapshot: async (owner, closeConnections) => {
      const template = names[owner];
      if (!template) throw new Error(`No ${owner} clone to snapshot`);
      await closeConnections();
      const name = `qa_${sources.suffix}_${owner}_s${++snapshots}`;
      const copy = await sources.connect(sources.adminUrl);
      const ownership = connection === 'owner' ? ` OWNER ${owner}` : '';
      try {
        await copy.query(`CREATE DATABASE ${name} WITH TEMPLATE ${template}${ownership}`);
        created.push(name);
      } finally { await copy.end(); }
      return databaseUrl(baseFor(owner), name);
    },
    close: async () => {
      const cleanup = await sources.connect(sources.adminUrl);
      try { await dropClones(cleanup, created); }
      finally { await cleanup.end(); }
    },
  };
}
