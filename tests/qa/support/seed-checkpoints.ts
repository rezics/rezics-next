import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fixtureRoot } from '../../../scripts/fixture/stack.ts';
import { seedVerificationPlan } from '../../../scripts/qa/seed-verification.ts';
import { workProfileCorpusApi, type CorpusApi, type WorkProfileCorpusManifest }
  from '../../../scripts/load/work-profile-corpus.ts';
import type { seedPublicProfileWork } from '../../../scripts/load/work-profile-work.ts';
import { verifySeedCheckpointPopulation, type SeedCheckpointPopulation } from './seed-checkpoint-population.ts';
import { SEED_AXES, SEED_RECIPE, type SeedAxis } from './seed-checkpoint-plan.ts';
import type { MediaStack } from '../integration/media-support.ts';
import type { WorkProfile } from './work-profile.ts';
import { settlePendingAnswer } from './command-race.ts';

export const SEED_BUILD_COMMAND = 'bun scripts/goal/goalctl.ts test tests/qa/fault-recovery/work-profile-seed-build.test.ts';
export function seedDirectoryForFixtureRoot(fixtureDirectory: string): string {
  return join(dirname(resolve(fixtureDirectory)), 'work-profiles', 'seed-checkpoints');
}
export const seedDirectory = seedDirectoryForFixtureRoot(fixtureRoot);
export const retainedSeedPath = join(seedDirectory, 'retained.json');
export const seedAuthorName = 'checkpoint-corpus-author';
export type SeedWork = Awaited<ReturnType<typeof seedPublicProfileWork>>;
export interface RetainedSeedCut {
  manifest: WorkProfileCorpusManifest;
  works: SeedWork[];
  posts: SeedPost[];
  population: SeedCheckpointPopulation;
  timing: { startupMs: number; buildMs: number; backupMs: number; totalMs: number; admissionWaitMs?: number };
}
export interface RetainedSeed {
  format: 'seed-checkpoints-v3';
  sourceRunId: string;
  actor: string;
  cuts: RetainedSeedCut[];
  axes: Record<SeedAxis, RetainedSeedCut[]>;
}
export interface SeedPost { post: string; variantId: string; revisionId: string; byteDigest: string }
export function seedVerificationCuts(seed: Pick<RetainedSeed, 'cuts'>, selection = 'all'): RetainedSeedCut[] {
  return seedVerificationPlan(selection).scales.map(scale => {
    const cut = seed.cuts.find(cut => cut.manifest.scale === scale);
    if (!cut) throw new Error(`Retained seed cut ${scale} is absent`);
    return cut;
  });
}
export type SeedCommandCostStage = '4' | '16' | '64';
export interface SeedCommandMeasurement {
  operation: string;
  profile: Pick<WorkProfile, 'totalLatencyMs' | 'postgresStatements' | 'fusekiRequests' | 'unclassifiedFetches' | 'unobserved'>;
}
export interface SeedCommandCostRow {
  operation: string;
  count: number;
  ms: number;
  sql: number;
  fuseki: number;
}
export interface SeedCommandCostComparisonRow {
  operation: string;
  at4?: SeedCommandCostRow;
  at16?: SeedCommandCostRow;
  at64?: SeedCommandCostRow;
  ratio64To4: number | null;
  grows: boolean;
}
function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}
export function buildSeedCommandCostReport(measured: readonly SeedCommandMeasurement[]): {
  rows: SeedCommandCostRow[];
  markdown: string;
} {
  const groups = new Map<string, SeedCommandMeasurement[]>();
  for (const item of measured) {
    const group = groups.get(item.operation) ?? [];
    group.push(item);
    groups.set(item.operation, group);
  }
  const rows = [...groups].map(([operation, values]) => {
    if (values.some(item => item.profile.postgresStatements === null || item.profile.fusekiRequests === null
      || item.profile.unclassifiedFetches || item.profile.unobserved.some(gap => gap.endsWith('SQL descendants'))))
      throw new Error(`Incomplete existing request meters for ${operation}`);
    return { operation, count: values.length, ms: median(values.map(item => item.profile.totalLatencyMs)),
      sql: median(values.map(item => item.profile.postgresStatements!)),
      fuseki: median(values.map(item => item.profile.fusekiRequests!)) };
  }).sort((left, right) => right.ms - left.ms || left.operation.localeCompare(right.operation));
  const markdown = [
    '| API operation class | Count | Median time (ms) | SQL statements / command (median) | Fuseki calls / command (median) |',
    '| --- | ---: | ---: | ---: | ---: |',
    ...rows.map(row => `| ${row.operation} | ${row.count} | ${row.ms.toFixed(1)} | ${row.sql} | ${row.fuseki} |`),
  ].join('\n') + '\n';
  return { rows, markdown };
}
export function buildSeedCommandCostComparison(stages: Record<SeedCommandCostStage, readonly SeedCommandCostRow[]>): {
  rows: SeedCommandCostComparisonRow[];
  markdown: string;
} {
  const byStage = Object.fromEntries((['4', '16', '64'] as const).map(stage => [stage,
    new Map(stages[stage].map(row => [row.operation, row]))])) as Record<SeedCommandCostStage, Map<string, SeedCommandCostRow>>;
  const operations = new Set([...byStage['4'].keys(), ...byStage['16'].keys(), ...byStage['64'].keys()]);
  const rows = [...operations].map(operation => {
    const at4 = byStage['4'].get(operation), at16 = byStage['16'].get(operation), at64 = byStage['64'].get(operation);
    const ratio64To4 = at4 && at64
      ? at4.ms === 0 ? (at64.ms === 0 ? null : Number.POSITIVE_INFINITY) : at64.ms / at4.ms
      : null;
    const grows = Boolean(at4 && at64
      && (at64.ms > at4.ms * 1.5 || at64.sql > at4.sql * 1.5));
    return { operation, at4, at16, at64, ratio64To4, grows };
  }).sort((left, right) => (right.at64?.ms ?? right.at16?.ms ?? right.at4?.ms ?? -1)
    - (left.at64?.ms ?? left.at16?.ms ?? left.at4?.ms ?? -1) || left.operation.localeCompare(right.operation));
  const cell = (row: SeedCommandCostRow | undefined, key: 'ms' | 'sql' | 'fuseki') => {
    const value = row?.[key];
    return value === undefined ? '—' : key === 'ms' ? value.toFixed(1) : String(value);
  };
  const ratio = (value: number | null) => value === null ? '—' : Number.isFinite(value) ? `${value.toFixed(2)}x` : '∞';
  const markdown = [
    '| API operation class | 4 median ms | 4 SQL median | 4 Fuseki median | 16 median ms | 16 SQL median | 16 Fuseki median | 64 median ms | 64 SQL median | 64 Fuseki median | 64/4 median time | Trend |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | :---: |',
    ...rows.map(row => `| ${row.operation} | ${cell(row.at4, 'ms')} | ${cell(row.at4, 'sql')} | ${cell(row.at4, 'fuseki')} | ${cell(row.at16, 'ms')} | ${cell(row.at16, 'sql')} | ${cell(row.at16, 'fuseki')} | ${cell(row.at64, 'ms')} | ${cell(row.at64, 'sql')} | ${cell(row.at64, 'fuseki')} | ${ratio(row.ratio64To4)} | ${row.grows ? 'GROWS' : '—'} |`),
  ].join('\n') + '\n';
  return { rows, markdown };
}
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
function processIsGone(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
}
function existingBuildLockMessage(path: string): string {
  let pid: number | undefined, runId: string | undefined;
  try {
    const holder = JSON.parse(readFileSync(path, 'utf8')) as { pid?: unknown; runId?: unknown };
    if (typeof holder.pid === 'number' && Number.isSafeInteger(holder.pid) && holder.pid > 0) pid = holder.pid;
    if (typeof holder.runId === 'string' && holder.runId.length > 0) runId = holder.runId;
  } catch { /* An incomplete lock fails closed and can still be removed explicitly. */ }
  const stale = pid !== undefined && processIsGone(pid);
  return `Seed checkpoint build lock exists for pid ${pid ?? 'unknown'} and run ID ${runId ? JSON.stringify(runId) : 'unknown'}${stale ? ' (stale: process is not running)' : ''}. If the holder has stopped, remove it with: rm -f -- ${shellQuote(path)}`;
}
export function acquireSeedBuildLock(runId: string, directory = seedDirectory): () => void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lockPath = join(directory, '.build.lock');
  const token = randomUUID();
  const pendingPath = join(directory, `.build-lock-${token}.pending`);
  try {
    writeFileSync(pendingPath, `${JSON.stringify({ pid: process.pid, runId, token })}\n`, { flag: 'wx', mode: 0o600 });
    linkSync(pendingPath, lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(existingBuildLockMessage(lockPath));
    throw error;
  } finally {
    rmSync(pendingPath, { force: true });
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    let owner: { token?: unknown };
    try { owner = JSON.parse(readFileSync(lockPath, 'utf8')) as { token?: unknown }; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (owner.token === token) unlinkSync(lockPath);
  };
}
export function saveRetainedSeed(seed: RetainedSeed) {
  mkdirSync(seedDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(`${retainedSeedPath}.pending`, JSON.stringify(seed, null, 2) + '\n', { mode: 0o600 });
  renameSync(`${retainedSeedPath}.pending`, retainedSeedPath);
}
export function readRetainedSeed(path = retainedSeedPath): RetainedSeed {
  if (!existsSync(path)) throw new Error(`Retained seed checkpoints are absent. Build them explicitly: ${SEED_BUILD_COMMAND}`);
  let seed: RetainedSeed;
  try { seed = JSON.parse(readFileSync(path, 'utf8')) as RetainedSeed; }
  catch { throw new Error(`Retained seed checkpoints are invalid. Build them explicitly: ${SEED_BUILD_COMMAND}`); }
  if (seed.format !== 'seed-checkpoints-v3' || !Array.isArray(seed.cuts) || seed.cuts.length !== 3
    || seed.cuts.some((cut, index) => cut.manifest.scale !== ['small', 'medium', 'large'][index]
      || !existsSync(cut.manifest.backup)))
    throw new Error(`Retained seed checkpoints are incomplete. Build them explicitly: ${SEED_BUILD_COMMAND}`);
  for (const axis of SEED_AXES) {
    const cuts = seed.axes?.[axis];
    if (!Array.isArray(cuts) || cuts.length !== 3 || cuts.some((cut, index) =>
      cut.manifest.recipe !== SEED_RECIPE || cut.manifest.dimension !== axis
      || cut.manifest.scale !== ['small', 'medium', 'large'][index]
      || !existsSync(cut.manifest.backup) || !Array.isArray(cut.posts) || !Array.isArray(cut.population?.works)))
      throw new Error(`Retained seed axis ${axis} is incomplete. Build them explicitly: ${SEED_BUILD_COMMAND}`);
  }
  return seed;
}
export function seedApi(stack: MediaStack, token: string): CorpusApi {
  return workProfileCorpusApi('http://main.local', token, {
    fetch: (async (input, init) => {
      const send = () => {
        init?.signal?.throwIfAborted();
        return stack.main.handle(new Request(input, init));
      };
      // Preparation follows the existing public retry protocol with the same
      // body and key. A pending answer never becomes a retained completion.
      return settlePendingAnswer(await send(), send, {},
        reason => { throw new Error(`Seed preparation ${init?.method} ${new URL(String(input)).pathname}: ${reason}`); },
        async () => {});
    }) as typeof fetch,
  });
}
export const seedSelection = (id: string): `/v1/${string}` => `/v1/main-versions/${id.slice(-36)}/selection?language=en`;
export async function seedCensus(api: CorpusApi, cut: Pick<RetainedSeedCut, 'works' | 'posts' | 'population'>) {
  const ids = new Set<string>();
  for (const [index, created] of cut.works.entries()) {
    const selected = await api.read(seedSelection(created.mainVersion));
    expect(selected).toMatchObject({ work: created.work, mainVersion: created.mainVersion,
      contribution: created.contribution, selectedDraft: created.draftRevision,
      body: `Checkpoint selected text ${index}` });
    ids.add(created.work);
  }
  expect(ids.size).toBe(cut.works.length);
  const related = new Set(cut.population.works.map(work => work.work));
  expect(cut.works.every(work => !related.has(work.work))).toBe(true);
  const posts = new Set<string>();
  for (const post of cut.posts) {
    const selected = await api.read(`/v1/posts/${post.post.slice(-36)}?actingSubject=${encodeURIComponent(cut.population.actor)}`);
    expect(selected).toMatchObject({ id: post.post, publisher: cut.population.actor,
      disclosure: 'public', placements: [] });
    posts.add(post.post);
  }
  expect(posts.size).toBe(cut.posts.length);
  return { unrelatedWorks: ids.size, unrelatedPosts: posts.size, follows: 0, memberships: 0,
    historyDepth: 0, realmSize: 0, conceptVocabulary: 0,
    ...await verifySeedCheckpointPopulation(api, cut.population) };
}
