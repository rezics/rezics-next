import { runCrossMediaSeedCli } from '../../services/importer/src/cross-media-seed.ts';
import { resolve, join } from 'node:path';
import { fetchCrossMediaDumps } from './fetch-dumps.ts';

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}; configure the local development persona and origins first`);
  return value;
}

async function runDevelopmentSeed(): Promise<void> {
  const accountKey = requiredEnvironment('REZICS_DEV_PERSONA_ACCOUNT_KEY');
  const account = requiredEnvironment('REZICS_DEV_PERSONA_ACCOUNT');
  const client = requiredEnvironment('REZICS_DEV_PERSONA_CLIENT');
  const auth = requiredEnvironment('AUTH_ORIGIN');
  const api = process.env.KERNEL_ORIGIN || `http://127.0.0.1:${process.env.KERNEL_PORT || '4100'}`;
  const dumps = await fetchCrossMediaDumps();
  const root = resolve(import.meta.dir, '../..');
  const state = join(root, '.temp', 'cross-media-seed', 'state.sqlite');
  const result = join(root, '.temp', 'cross-media-seed', 'result.json');
  await runCrossMediaSeedCli([
    '--bangumi',
    dumps.bangumi,
    '--vndb',
    dumps.vndb,
    '--state',
    state,
    '--result',
    result,
    '--api',
    api,
    '--auth',
    auth,
    '--account-key',
    accountKey,
    '--account',
    account,
    '--client',
    client,
  ]);
}

if (import.meta.main) {
  try {
    const args = Bun.argv.slice(2);
    if (args.length === 1 && args[0] === '--dev') await runDevelopmentSeed();
    else await runCrossMediaSeedCli(args);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Cross-media seed failed'}\n`);
    process.exitCode = 1;
  }
}
