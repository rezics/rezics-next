import { runCrossMediaSeedCli } from '../../services/importer/src/cross-media-seed.ts';
import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createAccountTokenProvider, IMPORTER_SCOPES } from '../../services/importer/src/credentials.ts';
import { createImportTransport } from '../../services/importer/src/import-client.ts';
import { seedReviewedCatalogue } from '../../services/importer/src/reviewed-catalogue.ts';
import { fetchCrossMediaDumps } from './fetch-dumps.ts';

/** Exact development roots: Steins;Gate/CLANNAD VNDB VNs; Steins;Gate anime/book and CLANNAD anime in Bangumi. */
export const developmentShowcaseSelection = {
  bangumi: [10380, 84148, 51],
  vndb: ['v2002', 'v4'],
  includeReleases: false,
  peoplePerProvider: 64,
} as const;

function requiredEnvironment(name: string, env: NodeJS.ProcessEnv): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}; configure the local development persona and origins first`);
  return value;
}

export async function runDevelopmentSeed(
  options: {
    env?: NodeJS.ProcessEnv;
    fetchDumps?: typeof fetchCrossMediaDumps;
    seedCatalogue?: typeof seedReviewedCatalogue;
    runSeed?: typeof runCrossMediaSeedCli;
    createTokenProvider?: typeof createAccountTokenProvider;
    seedCatalogue?: typeof seedReviewedCatalogue;
    root?: string;
  } = {},
): Promise<void> {
  const env = options.env ?? process.env;
  const accountKey = requiredEnvironment('REZICS_DEV_PERSONA_ACCOUNT_KEY', env);
  const account = requiredEnvironment('REZICS_DEV_PERSONA_ACCOUNT', env);
  const client = requiredEnvironment('REZICS_DEV_PERSONA_CLIENT', env);
  const auth = requiredEnvironment('AUTH_ORIGIN', env);
  const api = env.KERNEL_ORIGIN || 'http://127.0.0.1:' + (env.KERNEL_PORT || '4100');
  const characterVocabulary = env.REZICS_DEV_VNDB_CHARACTER_VOCABULARY?.trim();
  const dumps = await (options.fetchDumps ?? fetchCrossMediaDumps)();
  const root = options.root ?? resolve(import.meta.dir, '../..');
  const state = join(root, '.temp', 'cross-media-seed', 'state.sqlite');
  const showcase = join(root, '.temp', 'cross-media-seed', 'showcase.sqlite');
  const result = join(root, '.temp', 'cross-media-seed', 'result.json');
  await mkdir(dirname(state), { recursive: true });
  const tokenProvider = await (options.createTokenProvider ?? createAccountTokenProvider)({
    accountKeyPath: accountKey,
    account,
    client,
    authOrigin: auth,
    scopes: [...IMPORTER_SCOPES, 'subject:read', 'context:accept', 'context:adopt'],
  });
  const reviewedCatalogue = await (options.seedCatalogue ?? seedReviewedCatalogue)({
    path: state,
    port: createImportTransport({ origin: api, tokenProvider }),
  });
  const args = [
    '--bangumi',
    dumps.bangumi,
    '--vndb',
    dumps.vndb,
    '--state',
    state,
    '--showcase-state',
    showcase,
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
  ];
  if (characterVocabulary) args.push('--vndb-character-vocabulary', characterVocabulary);
  await (options.runSeed ?? runCrossMediaSeedCli)(args, {
    episodeCatalogueSubjects: reviewedCatalogue.subjects,
    reviewedCatalogueSubjects: reviewedCatalogue.subjects,
    selection: developmentShowcaseSelection,
  });
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
