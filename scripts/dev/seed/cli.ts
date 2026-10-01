import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { readEnv, stackDirectory } from '../config.ts';
import { devResetTarget } from '../reset.ts';
import { SeedApi, SeedApiError, type SeedEndpoints } from './api.ts';
import { seedAccounts } from './accounts-step.ts';
import { seedAdoptions } from './adoptions-step.ts';
import { seedChapters } from './chapters-step.ts';
import { checkPublicReads } from './checks-step.ts';
import { seedClassics } from './classics-step.ts';
import { seedCommunityDiscussions, seedCommunityVotes } from './community-discussions.ts';
import { communityPeople, communityRealms } from './community-plan.ts';
import { seedCommunityRealms } from './community-step.ts';
import { seedContributions } from './contributions-step.ts';
import { seedHomeFeed } from './feed-step.ts';
import { seedFranchises } from './franchises-step.ts';
import { seedLnVnZones } from './ln-vn-zones-step.ts';
import { seedBookConcepts } from './genres-step.ts';
import { seedLibrary } from './library-step.ts';
import { seedModeration } from './moderation-step.ts';
import { seedOfficialZones } from './official-zones-step.ts';
import { seedZoneSites } from './zone-sites-step.ts';
import { seedOfficialThemes } from './official-theme-step.ts';
import { people, realms, works } from './plan.ts';
import { seedProfileBios } from './profile-bios-step.ts';
import { seedProfileCredits } from './profile-credits-step.ts';
import { seedProfileFollows } from './profile-follows-step.ts';
import { seedProfileShelves } from './profile-shelves-step.ts';
import { seedRatings } from './ratings.ts';
import { waitForSeedApis } from './readiness.ts';
import { seedRecipes } from './recipes-step.ts';
import { seedCoReaders } from './reading-lives-coreaders.ts';
import { seedReadingLives } from './reading-lives-step.ts';
import { seedRealms } from './realms-step.ts';
import { seedReleases } from './releases-step.ts';
import { printSeedReport } from './report-step.ts';
import { seedReviews } from './reviews-step.ts';
import { refreshSeedTokens, type SeedState, type SeedStep } from './state.ts';
import { seedVnCatalogue } from './vn-catalogue-step.ts';
import { seedWorks } from './works-step.ts';

interface Options { dryRun: boolean; resetOwn: boolean; themesOnly: boolean; zonesOnly: boolean }

export function parseOptions(args: string[]): Options {
  if (args.some(arg => !['--dry-run', '--reset-own', '--themes-only', '--zones-only'].includes(arg))
    || new Set(args).size !== args.length
    || args.includes('--themes-only') && args.includes('--zones-only')) {
    throw new Error('Usage: bun scripts/dev/seed/cli.ts [--dry-run] [--reset-own] [--themes-only | --zones-only]');
  }
  return { dryRun: args.includes('--dry-run'), resetOwn: args.includes('--reset-own'),
    themesOnly: args.includes('--themes-only'), zonesOnly: args.includes('--zones-only') };
}

function commonRoot(): string {
  const root = resolve(import.meta.dir, '../../..');
  const common = execFileSync('git', ['rev-parse', '--git-common-dir'],
    { cwd: root, encoding: 'utf8' }).trim();
  return dirname(isAbsolute(common) ? common : resolve(root, common));
}

function configuration(): { endpoints: SeedEndpoints; fixture: SeedState['fixture'] } {
  const root = resolve(import.meta.dir, '../../..');
  const isolated = stackDirectory(root, devResetTarget(root, true));
  const worktree = commonRoot() !== root;
  const directory = Bun.env.REZICS_SEED_STACK_DIRECTORY
    ? resolve(Bun.env.REZICS_SEED_STACK_DIRECTORY)
    : worktree ? isolated : join(root, '.temp/stack/rezics-dev');
  const envPath = join(directory, 'dev.env');
  const publicPath = join(directory, 'web-auth/public.json');
  const privatePath = join(directory, 'web-auth/private.json');
  if (![envPath, publicPath].every(existsSync)) {
    throw new Error(worktree ? 'Isolated dev backend is absent; run task dev -- --backend in this worktree'
      : 'Shared dev stack is absent; start it from the main checkout with task dev');
  }
  const env = readEnv(envPath);
  const compose = readEnv(join(directory, 'compose.env'));
  const publicConfig = JSON.parse(readFileSync(publicPath, 'utf8')) as {
    clientId: string; redirectUris: string[]; scope: string; resource: string };
  const privateConfig = existsSync(privatePath)
    ? JSON.parse(readFileSync(privatePath, 'utf8')) as {
      operator?: { id: string; email: string; password: string } }
    : null;
  const account = env.ACCOUNT_ORIGIN ?? env.ACCOUNT_BASE_URL;
  const main = Bun.env.REZICS_SEED_MAIN_ORIGIN ?? env.MAIN_ORIGIN;
  if (!account || !main || !publicConfig.redirectUris[0] || !publicConfig.scope) {
    throw new Error('Dev stack lacks its public OAuth client');
  }
  for (const origin of [account, main]) {
    if (!['127.0.0.1', 'localhost'].includes(new URL(origin).hostname)) {
      throw new Error('The demo seed accepts loopback Account and Main APIs only');
    }
  }
  return { fixture: { operator: privateConfig?.operator?.id && env.ACCOUNT_DATABASE_URL
    && env.ACCESS_DATABASE_URL && env.ACCOUNT_SECRET ? privateConfig.operator : null,
    accountDatabaseUrl: env.ACCOUNT_DATABASE_URL ?? null,
    accessDatabaseUrl: env.ACCESS_DATABASE_URL ?? null, accountSecret: env.ACCOUNT_SECRET ?? null },
  endpoints: { account, main, enrollmentToken: env.ACCOUNT_ENROLLMENT_TOKEN,
    mailpit: `http://127.0.0.1:${compose.MAILPIT_HTTP_PORT}`,
    clientId: publicConfig.clientId, redirectUri: publicConfig.redirectUris[0],
    resource: publicConfig.resource, scope: publicConfig.scope } };
}

function describe(error: unknown): string {
  if (error instanceof SeedApiError) {
    let code = '', title = '';
    try {
      const detail = JSON.parse(error.detail) as { code?: string; title?: string };
      code = detail.code ?? ''; title = detail.title ?? '';
    } catch { /* opaque */ }
    return `${error.operation} HTTP ${error.status}${code ? ` ${code}` : ''}${title ? `: ${title}` : ''}`;
  }
  return error instanceof Error ? error.message : String(error);
}

// Each phase owns one file; this is the only ordering declaration. Shelves,
// community Realms, ratings and reviews follow the official Zones, which make
// the classics readable and publish the Works they discuss and rate. Votes wait
// a few steps for Home's projection; co-readers are built from all of it, last.
export const steps: readonly SeedStep[] = [
  seedAccounts, seedClassics, seedWorks, seedFranchises, seedVnCatalogue, seedLnVnZones, seedReleases, seedContributions, seedRealms, seedAdoptions,
  seedLibrary, seedChapters, seedModeration, seedHomeFeed,
  seedProfileCredits, seedProfileBios, seedProfileFollows, seedOfficialZones, seedRecipes, seedZoneSites, seedBookConcepts,
  seedOfficialThemes,
  seedProfileShelves, seedCommunityRealms, seedCommunityDiscussions, seedReadingLives, seedRatings,
  seedReviews, seedCommunityVotes, seedCoReaders,
  checkPublicReads, printSeedReport,
];

export function dryRunLines(): string[] {
  return [
    ...works.map(work => `  ${work.id}: ${work.title} [${work.type}]`),
    ...communityRealms.map(realm => `  Community Realm ${realm.id}: ${realm.name.en} (${realm.members.length} members)`),
    'Demo sign-in credentials:',
    ...[...people, ...communityPeople].map(person => `  ${person.name}: ${person.email} / ${person.password}`),
  ];
}

async function run(options: Options): Promise<boolean> {
  console.log(`Demo plan: ${people.length + communityPeople.length} accounts, ${works.length} Works, ${
    realms.length} official and ${communityRealms.length} community Realms.`);
  if (options.dryRun) {
    for (const line of dryRunLines()) console.log(line);
    if (options.resetOwn) console.log('Reset requires a public API to delete the seed-owned graph and Access data.');
    return true;
  }
  if (options.resetOwn) {
    throw new Error('--reset-own is unavailable: public APIs cannot remove seed-owned Works, '
      + 'Agents, Spaces and Access grants together. No data was changed.');
  }
  const { endpoints, fixture } = configuration();
  const writeCounts = { written: 0, replayed: 0, reconciled: 0, lookups: 0 };
  endpoints.writeCounts = writeCounts;
  await waitForSeedApis(endpoints);
  const findings = new Set<string>();
  const state: SeedState = { api: new SeedApi(endpoints), endpoints, fixture, findings,
    async optional<T>(label: string, operation: () => Promise<T>): Promise<T | null> {
      try { return await operation(); }
      catch (error) { findings.add(`${label}: ${describe(error)}`); return null; }
    },
    sessions: [], penAgents: new Map(), operatorInput: null, operatorSession: null, agentCount: 0,
    created: new Map(), createdRealms: [], seededZones: [],
    publishedCount: 0, selectedCount: 0, publicForRealm: new Map(), publicWorks: new Map(),
    ratingContext: null, communityRealms: new Map(), discussionVotes: [],
    commentCount: 0, replyCount: 0, reviewCount: 0, profileCreditCount: 0, profileFollowCount: 0 };
  const timings: string[] = [];
  const started = performance.now();
  const plan: readonly SeedStep[] = options.themesOnly
    ? [seedAccounts, state => seedOfficialThemes(state, realms.map(realm => realm.id))]
    : options.zonesOnly ? [seedAccounts, seedClassics, seedWorks, seedRealms, seedOfficialThemes] : steps;
  for (const step of plan) {
    const begun = performance.now();
    const before = { ...writeCounts };
    try {
      await refreshSeedTokens(state);
      await step(state);
    } catch (error) { throw new Error(`${step.name}: ${describe(error)}`); }
    timings.push(`  ${((performance.now() - begun) / 1000).toFixed(1).padStart(6)} s  ${step.name}`);
    const written = writeCounts.written - before.written;
    console.log(`${step.name}: ${written ? 'updated' : 'replayed'} (${written} writes, ${
      writeCounts.replayed - before.replayed} receipt replays, ${writeCounts.reconciled - before.reconciled} already match, ${
      writeCounts.lookups - before.lookups} catalogue lookups).`);
  }
  console.log(`Step timings (${((performance.now() - started) / 1000).toFixed(1)} s in all):`);
  for (const line of timings) console.log(line);
  console.log(`Seed record writes: ${writeCounts.written}; receipt replays: ${writeCounts.replayed}; already match: ${
    writeCounts.reconciled}; catalogue lookups: ${writeCounts.lookups}.`);
  if ((options.themesOnly || options.zonesOnly) && findings.size) {
    console.log('Zone seed findings:');
    for (const finding of findings) console.log(`  ${finding}`);
  }
  return findings.size === 0;
}

if (import.meta.main) {
  try { if (!await run(parseOptions(process.argv.slice(2)))) process.exitCode = 2; }
  catch (error) { console.error(describe(error)); process.exitCode = 1; }
}
