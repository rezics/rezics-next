import { expect } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { root } from '../../../scripts/fixture/stack.ts';
import { workProfileCorpusApi, type CorpusApi, type WorkProfileCorpusManifest }
  from '../../../scripts/load/work-profile-corpus.ts';
import type { seedPublicProfileWork } from '../../../scripts/load/work-profile-work.ts';
import { verifySeedCheckpointPopulation, type SeedCheckpointPopulation } from './seed-checkpoint-population.ts';
import type { MediaStack } from '../integration/media-support.ts';

export const SEED_BUILD_COMMAND = 'bun scripts/goal/goalctl.ts test tests/qa/fault-recovery/work-profile-seed-build.test.ts';
export const seedDirectory = join(root, '.temp/work-profiles/seed-checkpoints');
export const retainedSeedPath = join(seedDirectory, 'retained.json');
export const seedAuthorName = 'checkpoint-corpus-author';
export type SeedWork = Awaited<ReturnType<typeof seedPublicProfileWork>>;
export interface RetainedSeedCut {
  manifest: WorkProfileCorpusManifest;
  works: SeedWork[];
  population: SeedCheckpointPopulation;
  timing: { startupMs: number; buildMs: number; backupMs: number; totalMs: number };
}
export interface RetainedSeed {
  format: 'seed-checkpoints-v2';
  sourceRunId: string;
  actor: string;
  cuts: RetainedSeedCut[];
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
  if (seed.format !== 'seed-checkpoints-v2' || !Array.isArray(seed.cuts) || seed.cuts.length !== 3
    || seed.cuts.some((cut, index) => cut.manifest.scale !== ['small', 'medium', 'large'][index]
      || !existsSync(cut.manifest.backup)))
    throw new Error(`Retained seed checkpoints are incomplete. Build them explicitly: ${SEED_BUILD_COMMAND}`);
  return seed;
}
export function seedApi(stack: MediaStack, token: string): CorpusApi {
  return workProfileCorpusApi('http://main.local', token, {
    fetch: ((input, init) => stack.main.handle(new Request(input, init))) as typeof fetch,
  });
}
export const seedSelection = (id: string): `/v1/${string}` => `/v1/main-versions/${id.slice(-36)}/selection?language=en`;
export async function seedCensus(api: CorpusApi, cut: Pick<RetainedSeedCut, 'works' | 'population'>) {
  const ids = new Set<string>();
  for (const [index, created] of cut.works.entries()) {
    const selected = await api.read(seedSelection(created.mainVersion));
    expect(selected).toMatchObject({ work: created.work, mainVersion: created.mainVersion,
      contribution: created.contribution, selectedDraft: created.draftRevision,
      body: `Checkpoint selected text ${index}` });
    ids.add(created.work);
  }
  expect(ids.size).toBe(cut.works.length);
  return { unrelatedWorks: ids.size, unrelatedPosts: 0, follows: 0, memberships: 0,
    historyDepth: 0, realmSize: 0, conceptVocabulary: 0,
    ...await verifySeedCheckpointPopulation(api, cut.population) };
}
