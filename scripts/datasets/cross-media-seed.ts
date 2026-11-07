import { runCrossMediaSeedCli } from '../../services/importer/src/cross-media-seed.ts';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createKernelClient } from '@rezics/client';
import { createAccountTokenProvider, IMPORTER_SCOPES } from '../../services/importer/src/credentials.ts';
import { createImportTransport, ImportTransportError } from '../../services/importer/src/import-client.ts';
import { createImportFetch } from '../../services/importer/src/import-fetch.ts';
import {
  developmentPersonalListScopes,
  readShowcasePersonalListExport,
  seedShowcasePersonalList,
  type ShowcasePersonalListUpload,
} from '../../services/importer/src/showcase-personal-list.ts';
import { seedReviewedCatalogue } from '../../services/importer/src/reviewed-catalogue.ts';
import { createSeedDenialDiagnostics } from '../../services/importer/src/showcase-denial-diagnostics.ts';
import { fetchCrossMediaDumps, type CrossMediaDumpPaths } from './fetch-dumps.ts';
import { releaseWalkFileCache } from '../walk-memory.ts';
import { ShowcaseJournal, type ShowcasePublicationResult } from '../../services/importer/src/showcase-publication.ts';
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

type DevelopmentPublicationReport =
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
import {
  createDevelopmentShowcaseRequest,
  developmentCollectionFailure,
  developmentCollectionScopes,
  seedDevelopmentShowcase,
  type DevelopmentShowcaseResult,
} from './development-showcase.ts';

export type DevelopmentShowcaseReport = DevelopmentPublicationReport & {
  collections: DevelopmentShowcaseResult;
  personalList: ShowcasePersonalListUpload;
  sourceSnapshots: CrossMediaDumpPaths['sourceSnapshots'];
  sourcePublication: {
    state: 'published' | 'incomplete' | 'unavailable';
    assertions: number;
    omissions: number;
    code?: string;
  };
};

function sourcePublicationFailure(showcase?: ShowcasePublicationResult): DevelopmentSeedFailure {
  const refusal = showcase?.omissions.find(
    ({ code }) =>
      code.includes('fenced') ||
      ['review-http-401', 'review-http-403', 'review-http-409', 'review-http-412', 'review-http-423'].includes(code),
  );
  const code =
    refusal?.code ??
    showcase?.omissions[0]?.code ??
    (showcase ? 'publication-incomplete' : 'publication-result-missing');
  return {
    state: refusal ? 'refused' : 'unavailable',
    operation: 'source.publication',
    code,
  };
}

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
  if (bytes.byteLength > LOCAL_RESULT_LIMIT)
    throw new TypeError('Cross-media seed result exceeds its local report limit');
  const imported: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  const result =
    typeof imported === 'object' && imported !== null && !Array.isArray(imported)
      ? (imported as Record<string, unknown>)
      : undefined;
  if (!result || !Array.isArray(result.readings) || !Array.isArray(result.workLinks))
    throw new TypeError('Cross-media seed result is missing its native work identity handoff');
  await chmod(path, 0o600);
  await writeFile(path, JSON.stringify({ ...result, developmentShowcase: report }, null, 2) + '\n', { mode: 0o600 });
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
  const gameEnvironmentBindings = env.REZICS_DEV_BANGUMI_GAME_ENVIRONMENT_BINDINGS?.trim();
  const gameGenreBindings = env.REZICS_DEV_BANGUMI_GAME_GENRE_BINDINGS?.trim();
  const exportPath = env.REZICS_DEV_VNDB_EXPORT?.trim();
  const personalXml = exportPath ? await readShowcasePersonalListExport(exportPath) : undefined;
  const dumps = await (options.fetchDumps ?? fetchCrossMediaDumps)();
  const root = options.root ?? resolve(import.meta.dir, '../..');
  const state = join(root, '.temp', 'cross-media-seed', 'state.sqlite');
  const showcase = join(root, '.temp', 'cross-media-seed', 'showcase.sqlite');
  const result = join(root, '.temp', 'cross-media-seed', 'result.json');
  await mkdir(dirname(state), { recursive: true, mode: 0o700 });
  await chmod(dirname(state), 0o700);
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
  if (gameEnvironmentBindings) args.push('--bangumi-game-environment-bindings', gameEnvironmentBindings);
  if (gameGenreBindings) args.push('--bangumi-game-genre-bindings', gameGenreBindings);
  if (characterVocabulary) args.push('--vndb-character-vocabulary', characterVocabulary);
  const creatorToken = await (options.createTokenProvider ?? createAccountTokenProvider)({
    accountKeyPath: showcaseAccountKey,
    account,
    client: showcaseClient,
    authOrigin: auth,
    scopes: developmentCollectionScopes,
  });
  const request = createDevelopmentShowcaseRequest({ origin: api, token: creatorToken });
  const importedResult = await (options.runSeed ?? runCrossMediaSeedCli)(args, {
    includeBooks: true,
    episodeCatalogueSubjects: reviewedCatalogue.subjects,
    reviewedCatalogueSubjects: reviewedCatalogue.subjects,
    selection: developmentShowcaseSelection,
    ...(dumps.sourceSnapshots.vndb.timestamp === undefined
      ? {}
      : { sourceSnapshotAsOf: dumps.sourceSnapshots.vndb.timestamp.slice(0, 10) }),
    composePersona: (context) => seedDevelopmentShowcase({ ...context, accountId: account, request }),
    ...(process.env.REZICS_WALK_SMOL === '1' ? { onDumpTableReleased: releaseWalkFileCache } : {}),
  });
  if (!importedResult) throw new TypeError('Cross-media seed did not return its native result handoff');

  const credential = await credentialKeyId(showcaseAccountKey);
  const showcaseToken = await (options.createTokenProvider ?? createAccountTokenProvider)({
    accountKeyPath: showcaseAccountKey,
    account,
    client: showcaseClient,
    authOrigin: auth,
    scopes: [...DEVELOPMENT_SHOWCASE_SCOPES, ...developmentPersonalListScopes],
  });
  const actor = { accountId: account, clientId: showcaseClient };
  const journal = new ShowcaseJournal(showcase);
  let report: DevelopmentPublicationReport;
  let personalList: ShowcasePersonalListUpload;
  try {
    personalList =
      personalXml === undefined
        ? { state: 'unavailable', code: 'export-not-configured' }
        : await seedShowcasePersonalList({
            client: createKernelClient(api, {
              fetch: createImportFetch({
                origin: api,
                token: showcaseToken,
                maxAttempts: 3,
                deadlineMs: 30_000,
              }),
            }),
            journal,
            xml: personalXml,
            identity: { origin: new URL(api).origin, actor, credential: { keyId: credential } },
          });
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
  const collections = importedResult.persona!;
  const collectionFailure = developmentCollectionFailure(collections.collections);
  if (report.state === 'complete' && collectionFailure) {
    report = { ...report, state: 'incomplete', failure: collectionFailure };
  }
  if (report.state === 'complete' && personalList.state !== 'uploaded') {
    report = {
      ...report,
      state: 'incomplete',
      failure: {
        state: personalList.state === 'unknown-delivery' ? 'unknown_delivery' : personalList.state,
        operation: 'personal-list.preview',
        code: personalList.code,
      },
    };
  }
  const sourceShowcase = importedResult.showcase;
  const sourcePublication: DevelopmentShowcaseReport['sourcePublication'] = sourceShowcase
    ? {
        state: sourceShowcase.status,
        assertions: sourceShowcase.published.reduce((count, record) => count + record.assertions.length, 0),
        omissions: sourceShowcase.omissions.length,
      }
    : {
        state: 'unavailable',
        assertions: 0,
        omissions: 0,
        code: 'publication-result-missing',
      };
  if (report.state === 'complete' && sourcePublication.state !== 'published') {
    report = {
      ...report,
      state: 'incomplete',
      failure: sourcePublicationFailure(sourceShowcase),
    };
  }
  const composedReport: DevelopmentShowcaseReport = {
    ...report,
    collections,
    personalList,
    sourceSnapshots: dumps.sourceSnapshots,
    sourcePublication,
  };
  await attachDevelopmentShowcase(result, composedReport);
  if (report.state === 'complete') {
    process.stdout.write(
      `Development showcase: work=${report.community.source.subjectId} board=${report.community.board.id} ` +
        `thread=${report.community.thread.threadId} post=${report.community.thread.postId} ` +
        `edition=${report.edition.editionId} offer=${report.offer.offerId}\n`,
    );
  } else {
    process.stderr.write(
      `Development showcase ${report.failure.state} at ${report.failure.operation}: ${report.failure.code ?? 'no-code'}\n`,
    );
  }
  return composedReport;
}

/** Seed CLI prints only public HTTP classifiers; remote bodies and credentials stay off the walk log. */
export function seedFailureDetail(error: unknown): string {
  if (error instanceof ImportTransportError) {
    const detail = [error.status, error.code, error.type].filter((part) => part !== undefined && part !== '');
    return detail.length === 0 ? error.message : `${error.message} (${detail.join(' ')})`;
  }
  return error instanceof Error ? error.message : 'Cross-media seed failed';
}

if (import.meta.main) {
  try {
    const args = Bun.argv.slice(2);
    if (args.length === 1 && args[0] === '--dev') {
      if ((await runDevelopmentSeed()).state !== 'complete') process.exitCode = 1;
    } else await runCrossMediaSeedCli(args);
  } catch (error) {
    process.stderr.write(`${seedFailureDetail(error)}\n`);
    process.exitCode = 1;
  }
}
