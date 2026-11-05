import { runCrossMediaSeedCli } from '../../services/importer/src/cross-media-seed.ts';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createAccountTokenProvider, IMPORTER_SCOPES } from '../../services/importer/src/credentials.ts';
import { createImportTransport } from '../../services/importer/src/import-client.ts';
import { seedReviewedCatalogue } from '../../services/importer/src/reviewed-catalogue.ts';
import { createSeedDenialDiagnostics } from '../../services/importer/src/showcase-denial-diagnostics.ts';
import { fetchCrossMediaDumps } from './fetch-dumps.ts';
import { ShowcaseJournal } from '../../services/importer/src/showcase-publication.ts';
import {
  createDevelopmentShowcaseClient,
  DEVELOPMENT_SHOWCASE_SCOPES,
  seedDevelopmentCommunity,
  type DevelopmentSeedFailure,
} from './showcase-community.ts';
import { seedDevelopmentContentEdition } from './showcase-content-edition.ts';
import { seedDevelopmentContentEditionOffer } from './showcase-commerce-offer.ts';

const LOCAL_RESULT_LIMIT = 64 * 1024 * 1024;
const CREDENTIAL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

type PublishedCommunity = Extract<Awaited<ReturnType<typeof seedDevelopmentCommunity>>, { state: 'published' }>;
type PublishedEdition = Extract<Awaited<ReturnType<typeof seedDevelopmentContentEdition>>, { state: 'published' }>;
type CreatedOffer = Extract<Awaited<ReturnType<typeof seedDevelopmentContentEditionOffer>>, { state: 'created' }>;

export type DevelopmentShowcaseReport =
  | Readonly<{
      state: 'complete';
      community: PublishedCommunity;
      edition: PublishedEdition;
      offer: CreatedOffer;
    }>
  | Readonly<{
      state: 'incomplete';
      community: Awaited<ReturnType<typeof seedDevelopmentCommunity>>;
      edition?: Awaited<ReturnType<typeof seedDevelopmentContentEdition>>;
      offer?: Awaited<ReturnType<typeof seedDevelopmentContentEditionOffer>>;
      failure: DevelopmentSeedFailure;
    }>;

/** Exact development roots: Steins;Gate/CLANNAD VNDB VNs; Steins;Gate anime/book and CLANNAD anime in Bangumi. */
export const developmentShowcaseSelection = {
  bangumi: [10380, 84148, 51],
  vndb: ['v2002', 'v4'],
  includeReleases: true,
  peoplePerProvider: 64,
} as const;

function requiredEnvironment(name: string, env: NodeJS.ProcessEnv): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}; configure the local development persona and origins first`);
  return value;
}

async function credentialKeyId(path: string): Promise<string> {
  const bytes = await readFile(path);
  if (bytes.byteLength > 16 * 1024) throw new TypeError('Local showcase account key exceeds its size limit');
  const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    typeof Reflect.get(value, 'kid') !== 'string' ||
    !CREDENTIAL_ID.test(Reflect.get(value, 'kid') as string)
  )
    throw new TypeError('Local showcase account key has no valid credential identity');
  return Reflect.get(value, 'kid') as string;
}

async function attachDevelopmentShowcase(path: string, report: DevelopmentShowcaseReport): Promise<void> {
  const bytes = await readFile(path);
  if (bytes.byteLength > LOCAL_RESULT_LIMIT) throw new TypeError('Cross-media seed result exceeds its local report limit');
  const imported: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  const result =
    typeof imported === 'object' && imported !== null && !Array.isArray(imported)
      ? (imported as Record<string, unknown>)
      : undefined;
  if (!result || !Array.isArray(result.readings) || !Array.isArray(result.workLinks))
    throw new TypeError('Cross-media seed result is missing its native work identity handoff');
  await writeFile(path, JSON.stringify({ ...result, developmentShowcase: report }, null, 2) + '\n');
}

export async function runDevelopmentSeed(
  options: {
    env?: NodeJS.ProcessEnv;
    fetchDumps?: typeof fetchCrossMediaDumps;
    runSeed?: typeof runCrossMediaSeedCli;
    createTokenProvider?: typeof createAccountTokenProvider;
    seedCatalogue?: typeof seedReviewedCatalogue;
    root?: string;
  } = {},
): Promise<DevelopmentShowcaseReport> {
  const env = options.env ?? process.env;
  const accountKey = requiredEnvironment('REZICS_DEV_PERSONA_ACCOUNT_KEY', env);
  const account = requiredEnvironment('REZICS_DEV_PERSONA_ACCOUNT', env);
  const client = requiredEnvironment('REZICS_DEV_PERSONA_CLIENT', env);
  const showcaseAccountKey = requiredEnvironment('REZICS_DEV_SHOWCASE_ACCOUNT_KEY', env);
  const showcaseClient = requiredEnvironment('REZICS_DEV_SHOWCASE_CLIENT', env);
  const auth = requiredEnvironment('AUTH_ORIGIN', env);
  const api = env.KERNEL_ORIGIN || 'http://127.0.0.1:' + (env.KERNEL_PORT || '4100');
  const characterVocabulary = env.REZICS_DEV_VNDB_CHARACTER_VOCABULARY?.trim();
  const gameGenreBindings = env.REZICS_DEV_BANGUMI_GAME_GENRE_BINDINGS?.trim();
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
    port: createImportTransport({
      origin: api,
      tokenProvider,
      onDeniedResponse: createSeedDenialDiagnostics(join(dirname(state), 'diagnostics')),
    }),
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
  if (gameGenreBindings) args.push('--bangumi-game-genre-bindings', gameGenreBindings);
  if (characterVocabulary) args.push('--vndb-character-vocabulary', characterVocabulary);
  const importedResult = await (options.runSeed ?? runCrossMediaSeedCli)(args, {
    episodeCatalogueSubjects: reviewedCatalogue.subjects,
    reviewedCatalogueSubjects: reviewedCatalogue.subjects,
    selection: developmentShowcaseSelection,
  });
  if (!importedResult) throw new TypeError('Cross-media seed did not return its native result handoff');

  const credential = await credentialKeyId(showcaseAccountKey);
  const showcaseToken = await (options.createTokenProvider ?? createAccountTokenProvider)({
    accountKeyPath: showcaseAccountKey,
    account,
    client: showcaseClient,
    authOrigin: auth,
    scopes: DEVELOPMENT_SHOWCASE_SCOPES,
  });
  const actor = { accountId: account, clientId: showcaseClient };
  const journal = new ShowcaseJournal(showcase);
  let report: DevelopmentShowcaseReport;
  try {
    const native = createDevelopmentShowcaseClient({
      origin: api,
      actor,
      credential: { keyId: credential },
      tokenProvider: showcaseToken,
      journal,
    });
    const community = await seedDevelopmentCommunity({ result: importedResult, actor, client: native });
    if (community.state !== 'published') report = { state: 'incomplete', community, failure: community };
    else {
      const edition = await seedDevelopmentContentEdition({ community, actor, client: native });
      if (edition.state !== 'published') report = { state: 'incomplete', community, edition, failure: edition };
      else {
        const offer = await seedDevelopmentContentEditionOffer({ edition, accountId: account, client: native });
        report =
          offer.state === 'created'
            ? { state: 'complete', community, edition, offer }
            : { state: 'incomplete', community, edition, offer, failure: offer };
      }
    }
  } finally {
    journal.close();
  }
  await attachDevelopmentShowcase(result, report);
  if (report.state === 'complete') {
    process.stdout.write(
      `Development showcase: work=${report.community.source.subjectId} board=${report.community.board.id} ` +
        `thread=${report.community.thread.id} post=${report.community.thread.postId} ` +
        `edition=${report.edition.editionId} offer=${report.offer.offerId}\n`,
    );
  } else {
    process.stderr.write(
      `Development showcase ${report.failure.state} at ${report.failure.operation}: ${report.failure.code ?? 'no-code'}\n`,
    );
  }
  return report;
}
if (import.meta.main) {
  try {
    const args = Bun.argv.slice(2);
    if (args.length === 1 && args[0] === '--dev') {
      if ((await runDevelopmentSeed()).state !== 'complete') process.exitCode = 1;
    } else await runCrossMediaSeedCli(args);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Cross-media seed failed'}\n`);
    process.exitCode = 1;
  }
}
