import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { Client } from 'pg';
import { readEnv } from '../../../scripts/dev/config.ts';

type Owner = 'account' | 'access';

/** Clone the migrated QA templates for a file that changes shared authority state. */
export async function cloneQaAccountAccessDatabases(runId: string): Promise<{
  urls: Record<Owner, string>;
  close: () => Promise<void>;
}> {
  if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(runId)) {
    throw new Error('QA database clones require a valid run');
  }
  const root = resolve(import.meta.dir, '../../..');
  const stackDir = join(root, '.temp', 'stack', `rezics-qa-${runId}`);
  const compose = readEnv(join(stackDir, 'compose.env'));
  const apps = readEnv(join(stackDir, 'apps.env'));
  const admin = new Client({ connectionString:
    `postgres://postgres:${encodeURIComponent(compose.POSTGRES_PASSWORD!)}@127.0.0.1:${compose.POSTGRES_PORT}/postgres` });
  const suffix = randomBytes(6).toString('hex');
  const names: { owner: Owner; name: string }[] = (['account', 'access'] as const)
    .map(owner => ({ owner, name: `qa_${suffix}_${owner}` }));
  const urls = {} as Record<Owner, string>;
  const created: string[] = [];
  await admin.connect();
  try {
    for (const { owner, name } of names) {
      await admin.query(`CREATE DATABASE ${name} WITH TEMPLATE ${owner}_tpl OWNER ${owner}`);
      created.push(name);
      const url = new URL(apps[`${owner.toUpperCase()}_DATABASE_URL`]!);
      url.pathname = `/${name}`;
      urls[owner] = url.toString();
    }
  } catch (error) {
    for (const name of created.reverse()) await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await admin.end();
    throw error;
  }
  await admin.end();
  return {
    urls,
    close: async () => {
      const cleanup = new Client({ connectionString:
        `postgres://postgres:${encodeURIComponent(compose.POSTGRES_PASSWORD!)}@127.0.0.1:${compose.POSTGRES_PORT}/postgres` });
      await cleanup.connect();
      try {
        for (const { name } of names.reverse()) await cleanup.query(`DROP DATABASE ${name} WITH (FORCE)`);
      } finally { await cleanup.end(); }
    },
  };
}
