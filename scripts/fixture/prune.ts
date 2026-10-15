import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { redactCommandOutput } from './command-output.ts';
import { DEFAULT_SEED } from './corpus.ts';

/** Compose project of the shared dev stack. Other `rezics-dev-*` projects are not this stack. */
export const DEV_COMPOSE_PROJECT = 'rezics-dev';
const FIXTURE_ID = /^fx-(small|medium)-[0-9a-f]{12}$/;
const FIXTURE_LOCK = /^(fx-(?:small|medium)-[0-9a-f]{12})\.lock$/;
const SEED_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

export const FIXTURE_KEEP_REASONS = ['current', 'pinned', 'retained', 'in-use'] as const;
export type FixtureKeepReason = (typeof FIXTURE_KEEP_REASONS)[number];

/** One fixture generation as a prune command lists it, before any keep decision. */
export interface ListedGeneration {
  id: string;
  profile: string;
  seed: string;
  project: string;
  completedAt?: string;
  /** `restoreCompatibility` accepts the manifest. An interrupted build is not compatible. */
  compatible: boolean;
  /** This root has the generation's manifest. A volume alone is not one. */
  manifest: boolean;
  directory: boolean;
  volumes: readonly string[];
  /** A live process holds the generation's build lock. */
  buildInProgress: boolean;
}

export interface ListedVolume {
  name: string;
  project?: string;
}

export interface PruneInventory {
  generations: readonly ListedGeneration[];
  volumes: readonly ListedVolume[];
  /** Ids `fixture:build` would produce for each profile and seed it knows. */
  currentIds: readonly string[];
  pins: readonly string[];
  /** Volume names mounted by a running container. */
  mountedVolumes: readonly string[];
}

export interface KeptGeneration {
  id: string;
  reasons: FixtureKeepReason[];
  /** Manifest seed prune does not compute. Absent for the default seed. */
  uncomputedSeed?: string;
}

export interface RemovedGeneration {
  id: string;
  profile: string;
  directory: boolean;
  volumes: string[];
}

export interface VolumeProject {
  project: string;
  reason: 'dev' | 'in-use';
  volumes: string[];
}

export interface AbandonedProject {
  project: string;
  volumes: string[];
}

export interface PruneDecision {
  keep: KeptGeneration[];
  removeGenerations: RemovedGeneration[];
  keepProjects: VolumeProject[];
  abandoned: AbandonedProject[];
  unlabelled: string[];
}

export interface PruneScope {
  /** When set, only this profile's superseded generations are removed. */
  profile?: string;
  protectIds?: readonly string[];
}

function volumesByProject(volumes: readonly ListedVolume[]): Map<string, string[]> {
  const grouped = new Map<string, string[]>();
  for (const volume of volumes) {
    if (!volume.project) continue;
    const listed = grouped.get(volume.project) ?? [];
    listed.push(volume.name);
    grouped.set(volume.project, listed);
  }
  return grouped;
}

function volumesForGeneration(
  generation: ListedGeneration,
  grouped: ReadonlyMap<string, readonly string[]>,
): string[] {
  return [...new Set([...generation.volumes, ...(grouped.get(generation.project) ?? [])])].sort();
}

/** Pinned, retained, and in-use, including a held build lock. The current id is separate. */
function generationKeepReasons(
  generation: ListedGeneration,
  volumes: readonly string[],
  inventory: PruneInventory,
  retained: ReadonlySet<string>,
): FixtureKeepReason[] {
  const reasons: FixtureKeepReason[] = [];
  if (inventory.pins.includes(generation.id)) reasons.push('pinned');
  if (retained.has(generation.id)) reasons.push('retained');
  if (generation.buildInProgress || volumes.some((name) => inventory.mountedVolumes.includes(name)))
    reasons.push('in-use');
  return reasons;
}

/**
 * Keep a generation when a current consumer can still restore it.
 * `current` is the id `fixture:build` computes for the default seed.
 * `pinned` is an id in `PINNED_FIXTURE_IDS`. `retained` is the newest manifest
 * `restoreCompatibility` accepts for that profile and the default seed: the backup
 * `compatibleFixture` selects, which erasure-campaign-qualification restores.
 * `in-use` means a running container mounts the generation, or its build lock
 * is held. A manifest with any other seed is kept: prune does not compute it.
 * A volume with no manifest is superseded. Anything else of a default-seed
 * generation is superseded.
 * An overridden fixture root passes `accountedPruneInventory` first, so a
 * volume whose manifest lives in another root is neither kept nor removed.
 */
export function decideFixturePrune(inventory: PruneInventory): PruneDecision {
  const current = new Set(inventory.currentIds);
  const mounted = new Set(inventory.mountedVolumes);
  const retained = retainedGenerationIds(inventory.generations);
  const groupedVolumes = volumesByProject(inventory.volumes);
  const generationProjects = new Set(inventory.generations.map((generation) => generation.project));
  const keep: KeptGeneration[] = [];
  const removeGenerations: RemovedGeneration[] = [];
  for (const generation of inventory.generations) {
    const volumes = volumesForGeneration(generation, groupedVolumes);
    const reasons = generationKeepReasons(generation, volumes, inventory, retained);
    if (current.has(generation.id)) reasons.unshift('current');
    const uncomputedSeed =
      generation.manifest && generation.seed !== '' && generation.seed !== DEFAULT_SEED
        ? generation.seed
        : undefined;
    if (reasons.length || uncomputedSeed)
      keep.push({ id: generation.id, reasons, ...(uncomputedSeed ? { uncomputedSeed } : {}) });
    else
      removeGenerations.push({
        id: generation.id,
        profile: generation.profile,
        directory: generation.directory,
        volumes,
      });
  }
  const keepProjects: VolumeProject[] = [];
  const abandonedGroups = new Map<string, string[]>();
  for (const [project, names] of groupedVolumes) {
    if (generationProjects.has(project)) continue;
    // Other compose projects on the host are not this repository's to remove.
    if (!project.startsWith('rezics-')) continue;
    // QA stacks belong to the reaper and stack:reset, including while they are stopped.
    if (project.startsWith('rezics-qa-')) continue;
    const volumes = [...new Set(names)].sort();
    if (project === DEV_COMPOSE_PROJECT) keepProjects.push({ project, reason: 'dev', volumes });
    else if (volumes.some((name) => mounted.has(name)))
      keepProjects.push({ project, reason: 'in-use', volumes });
    else abandonedGroups.set(project, volumes);
  }
  const abandoned = [...abandonedGroups.entries()]
    .map(([project, volumes]) => ({ project, volumes }))
    .sort((left, right) => left.project.localeCompare(right.project));
  const unlabelled = [
    ...new Set(inventory.volumes.filter((volume) => !volume.project).map((volume) => volume.name)),
  ].sort();
  keep.sort((left, right) => left.id.localeCompare(right.id));
  removeGenerations.sort((left, right) => left.id.localeCompare(right.id));
  keepProjects.sort(
    (left, right) =>
      left.reason.localeCompare(right.reason) || left.project.localeCompare(right.project),
  );
  return { keep, removeGenerations, keepProjects, abandoned, unlabelled };
}

const FIXTURE_VOLUME_PROJECT = /^rezics-fixture-(fx-(?:small|medium)-[0-9a-f]{12})$/;

/**
 * The shared root may remove a generation known only by its volumes.
 * An overridden root removes a generation only when that root has its directory
 * and manifest. Other fixture volumes stay out of the listing.
 */
export function accountedPruneInventory(
  inventory: PruneInventory,
  localRoot: boolean,
): PruneInventory {
  if (!localRoot) return inventory;
  const generations = inventory.generations.filter(
    (generation) => generation.directory && generation.manifest,
  );
  const accounted = new Set(generations.map((generation) => generation.project));
  const volumes = inventory.volumes.filter((volume) => {
    if (!volume.project || !FIXTURE_VOLUME_PROJECT.test(volume.project)) return true;
    return accounted.has(volume.project);
  });
  return { ...inventory, generations, volumes };
}

/** Newest compatible manifest of each profile and seed. Tied completion times all stay. */
export function retainedGenerationIds(generations: readonly ListedGeneration[]): Set<string> {
  const best = new Map<string, string>();
  for (const generation of generations) {
    if (!generation.compatible || generation.completedAt === undefined) continue;
    const key = `${generation.profile}\0${generation.seed}`;
    const winner = best.get(key);
    if (winner === undefined || generation.completedAt > winner)
      best.set(key, generation.completedAt);
  }
  const ids = new Set<string>();
  for (const generation of generations) {
    if (!generation.compatible || generation.completedAt === undefined) continue;
    if (best.get(`${generation.profile}\0${generation.seed}`) === generation.completedAt)
      ids.add(generation.id);
  }
  return ids;
}

/** Removals a full prune or a same-size build prune will perform. */
export function pruneTargets(
  decision: PruneDecision,
  scope: PruneScope = {},
): {
  generations: RemovedGeneration[];
  abandoned: AbandonedProject[];
} {
  const protect = new Set(scope.protectIds ?? []);
  return {
    generations: decision.removeGenerations.filter(
      (generation) =>
        !protect.has(generation.id) &&
        (scope.profile === undefined || generation.profile === scope.profile),
    ),
    abandoned: scope.profile === undefined ? decision.abandoned : [],
  };
}

export interface SeedPruneRequest {
  seed: string;
  /** The generation this seed's builder just produced. */
  keepId: string;
}

/**
 * Generations of one seed its builder can remove once it knows the id to keep.
 * Another seed stays, including one a full prune would call superseded.
 * The kept id stays, as do pinned, retained and in-use generations.
 * The inventory is already root-accounted, the same rule as `fixture:prune`.
 */
export function seedPruneTargets(
  inventory: PruneInventory,
  request: SeedPruneRequest,
): RemovedGeneration[] {
  const retained = retainedGenerationIds(inventory.generations);
  const groupedVolumes = volumesByProject(inventory.volumes);
  const remove: RemovedGeneration[] = [];
  for (const generation of inventory.generations) {
    if (generation.seed !== request.seed || generation.id === request.keepId) continue;
    const volumes = volumesForGeneration(generation, groupedVolumes);
    if (generationKeepReasons(generation, volumes, inventory, retained).length) continue;
    remove.push({
      id: generation.id,
      profile: generation.profile,
      directory: generation.directory,
      volumes,
    });
  }
  remove.sort((left, right) => left.id.localeCompare(right.id));
  return remove;
}

export interface PruneOutcome {
  mode: 'dry-run' | 'apply';
  currentIds: readonly string[];
  pins: readonly string[];
  decision: PruneDecision;
  removedIds: string[];
  failures: { target: string; error: string }[];
}

export function formatPruneReport(
  outcome: Pick<PruneOutcome, 'mode' | 'currentIds' | 'pins' | 'decision' | 'failures'>,
): string {
  const lines = [`fixture prune: ${outcome.mode}`];
  for (const id of [...outcome.currentIds].sort()) lines.push(`current-id ${id}`);
  for (const id of outcome.pins) lines.push(`pin ${id}`);
  for (const generation of outcome.decision.keep) {
    const reasons = generation.reasons.join(',');
    const seed = generation.uncomputedSeed
      ? `kept: seed ${generation.uncomputedSeed} is not computed by prune`
      : '';
    lines.push(`keep ${generation.id} ${[reasons, seed].filter(Boolean).join(' ')}`);
  }
  for (const generation of outcome.decision.removeGenerations) {
    lines.push(`remove ${generation.id} superseded${generation.directory ? ' directory' : ''}`);
    for (const volume of generation.volumes) lines.push(`  volume ${volume}`);
  }
  for (const project of outcome.decision.keepProjects) {
    lines.push(`keep-project ${project.project} ${project.reason}`);
    for (const volume of project.volumes) lines.push(`  volume ${volume}`);
  }
  for (const project of outcome.decision.abandoned) {
    lines.push(`abandoned ${project.project}`);
    for (const volume of project.volumes) lines.push(`  volume ${volume}`);
  }
  for (const volume of outcome.decision.unlabelled) lines.push(`unlabelled ${volume}`);
  if (outcome.failures.length) {
    for (const failure of outcome.failures) lines.push(`failed ${failure.target} ${failure.error}`);
  }
  const decision = outcome.decision;
  lines.push(
    `summary keep=${decision.keep.length} remove=${decision.removeGenerations.length}` +
      ` abandoned-projects=${decision.abandoned.length}` +
      ` abandoned-volumes=${decision.abandoned.reduce((count, project) => count + project.volumes.length, 0)}` +
      ` unlabelled=${decision.unlabelled.length}`,
  );
  return lines.join('\n');
}

function buildLockHeld(lockPath: string): boolean {
  if (!existsSync(lockPath)) return false;
  const holder = Number(readFileSync(lockPath, 'utf8'));
  if (!Number.isSafeInteger(holder) || holder <= 0) return false;
  try {
    process.kill(holder, 0);
    return true;
  } catch {
    return false;
  }
}

async function collectInventory(): Promise<PruneInventory> {
  const {
    fixtureDirectory,
    fixtureProject,
    fixtureRoot,
    dockerEnvironment,
    listDockerVolumes,
    mountedVolumeNames,
    PINNED_FIXTURE_IDS,
    fixtureRootIsOverridden,
    root,
  } = await import('./stack.ts');
  const { readManifest } = await import('./build.ts');
  const { fixtureRestoreInputs } = await import('./restore.ts');
  const { restoreCompatibility, manifestCore, manifestIdentity, manifestCorpus } = await import('./manifest.ts');
  const { DEFAULT_SEED, PROFILES, fixtureCorpus } = await import('./corpus.ts');
  const { fixtureOwners } = await import('./owners/index.ts');
  const docker = dockerEnvironment();
  const volumes = listDockerVolumes(docker);
  const mountedVolumes = mountedVolumeNames(docker);
  const ids = new Set<string>();
  let entries: { name: string; isDirectory: () => boolean }[] = [];
  try {
    entries = readdirSync(fixtureRoot, { withFileTypes: true });
  } catch {
    /* no fixture root yet */
  }
  for (const entry of entries) {
    if (entry.isDirectory() && FIXTURE_ID.test(entry.name)) ids.add(entry.name);
    const lock = FIXTURE_LOCK.exec(entry.name);
    if (lock?.[1]) ids.add(lock[1]);
  }
  for (const volume of volumes) {
    const match = /^rezics-fixture-(fx-(?:small|medium)-[0-9a-f]{12})$/.exec(volume.project ?? '');
    if (match?.[1]) ids.add(match[1]);
  }
  const generations: ListedGeneration[] = [...ids].sort().map((id) => {
    const manifest = readManifest(id);
    const profile = manifest?.profile ?? (id.startsWith('fx-small-') ? 'small' : 'medium');
    const directory = fixtureDirectory(id);
    return {
      id,
      profile,
      seed: manifest?.seed ?? '',
      project: fixtureProject(id),
      ...(manifest ? { completedAt: manifest.build.completedAt } : {}),
      compatible: manifest ? restoreCompatibility(manifest, fixtureRestoreInputs(docker, manifestCorpus(manifest))).compatible : false,
      manifest: manifest !== undefined,
      directory: existsSync(directory),
      volumes: [],
      buildInProgress: buildLockHeld(`${directory}.lock`),
    };
  });
  const { currentEngines } = await import('./stack.ts');
  const engines = currentEngines(docker);
  const pairs = new Map<string, { profile: 'small' | 'medium'; seed: string }>();
  const addPair = (profile: string, seed: string) => {
    if (profile !== 'small' && profile !== 'medium') return;
    if (!SEED_NAME.test(seed)) return;
    pairs.set(`${profile}\0${seed}`, { profile, seed });
  };
  for (const profile of Object.keys(PROFILES)) addPair(profile, DEFAULT_SEED);
  const currentIds = [...pairs.values()].map(
    ({ profile, seed }) =>
      manifestIdentity(manifestCore(root, fixtureCorpus(profile, seed), fixtureOwners, engines)).id,
  );
  return accountedPruneInventory(
    {
      generations,
      volumes,
      currentIds,
      pins: [...PINNED_FIXTURE_IDS],
      mountedVolumes,
    },
    fixtureRootIsOverridden(),
  );
}

function removalError(error: unknown): string {
  return redactCommandOutput(error instanceof Error ? error.message : String(error));
}

export interface GenerationRemoval {
  removedIds: string[];
  failures: { target: string; error: string }[];
}

/** Stopped containers first, then volumes, then the generation directory. */
async function removeGenerations(
  generations: readonly RemovedGeneration[],
): Promise<GenerationRemoval> {
  const { dockerEnvironment, fixtureDirectory, fixtureProject, removeStoppedContainers, removeVolumes } =
    await import('./stack.ts');
  const docker = dockerEnvironment();
  const failures: { target: string; error: string }[] = [];
  const removedIds: string[] = [];
  for (const generation of generations) {
    if (!FIXTURE_ID.test(generation.id)) {
      failures.push({
        target: generation.id,
        error: 'refusing an id that is not a fixture generation',
      });
      continue;
    }
    try {
      removeStoppedContainers(fixtureProject(generation.id), docker);
      removeVolumes(generation.volumes, docker);
      const directory = fixtureDirectory(generation.id);
      rmSync(directory, { recursive: true, force: true });
      rmSync(`${directory}.lock`, { force: true });
      removedIds.push(generation.id);
    } catch (error) {
      failures.push({ target: generation.id, error: removalError(error) });
    }
  }
  return { removedIds, failures };
}

/** Dry run unless `apply` is set. A profile scope leaves other sizes and abandoned projects alone. */
export async function executeFixturePrune(
  options: { apply: boolean } & PruneScope,
): Promise<PruneOutcome> {
  const inventory = await collectInventory();
  const decision = decideFixturePrune(inventory);
  const targets = pruneTargets(decision, options);
  const failures: { target: string; error: string }[] = [];
  const removedIds: string[] = [];
  if (options.apply) {
    const removed = await removeGenerations(targets.generations);
    failures.push(...removed.failures);
    removedIds.push(...removed.removedIds);
    const { dockerEnvironment, removeVolumes } = await import('./stack.ts');
    const docker = dockerEnvironment();
    const keptProjects = new Set([
      DEV_COMPOSE_PROJECT,
      ...decision.keep.map((generation) => `rezics-fixture-${generation.id}`),
      ...decision.keepProjects.map((project) => project.project),
    ]);
    for (const project of targets.abandoned) {
      if (keptProjects.has(project.project)) {
        failures.push({
          target: project.project,
          error: 'refusing a project the prune decision kept',
        });
        continue;
      }
      try {
        removeVolumes(project.volumes, docker);
      } catch (error) {
        failures.push({ target: project.project, error: removalError(error) });
      }
    }
  }
  return {
    mode: options.apply ? 'apply' : 'dry-run',
    currentIds: inventory.currentIds,
    pins: inventory.pins,
    decision,
    removedIds,
    failures,
  };
}

/** After a successful build, drop superseded generations of that size only. */
export async function pruneSupersededGenerations(
  profile: string,
  protectId: string,
): Promise<string[]> {
  const outcome = await executeFixturePrune({ apply: true, profile, protectIds: [protectId] });
  if (outcome.failures.length) {
    throw new Error(
      outcome.failures.map((failure) => `${failure.target}: ${failure.error}`).join('; '),
    );
  }
  return outcome.removedIds;
}

export interface SeedPruneOutcome {
  mode: 'dry-run' | 'apply';
  removeGenerations: RemovedGeneration[];
  removedIds: string[];
  failures: { target: string; error: string }[];
}

/**
 * Dry run unless `apply` is set. Uses the same inventory as `fixture:prune`,
 * including the fixture root rule, and never removes another seed or an
 * abandoned project. Stopped containers are removed before volumes.
 */
export async function executeSeedPrune(
  options: SeedPruneRequest & {
    apply: boolean;
    /** Defaults to the docker remover. Tests pass a stand-in. */
    remove?: (generations: readonly RemovedGeneration[]) => Promise<GenerationRemoval>;
    /** Defaults to the host inventory. Tests pass a fixed one. */
    inventory?: PruneInventory;
  },
): Promise<SeedPruneOutcome> {
  if (!SEED_NAME.test(options.seed)) throw new Error('seed-scoped prune needs the builder seed');
  if (!FIXTURE_ID.test(options.keepId))
    throw new Error('seed-scoped prune keeps one fixture generation id');
  const inventory = options.inventory ?? (await collectInventory());
  const targets = seedPruneTargets(inventory, options);
  if (!options.apply) return { mode: 'dry-run', removeGenerations: targets, removedIds: [], failures: [] };
  const removed = await (options.remove ?? removeGenerations)(targets);
  return {
    mode: 'apply',
    removeGenerations: targets,
    removedIds: removed.removedIds,
    failures: removed.failures,
  };
}

/** Applies the seed prune. `failure` names how many generations failed and why. */
export async function pruneSeedGenerations(
  seed: string,
  keepId: string,
): Promise<{ removedIds: string[]; failure?: string }> {
  try {
    const outcome = await executeSeedPrune({ seed, keepId, apply: true });
    if (!outcome.failures.length) return { removedIds: outcome.removedIds };
    const why = outcome.failures
      .map((failure) => `${failure.target}: ${redactCommandOutput(failure.error)}`)
      .join('; ');
    return {
      removedIds: outcome.removedIds,
      failure: `seed prune failed for ${outcome.failures.length} generations: ${why}`,
    };
  } catch (error) {
    return {
      removedIds: [],
      failure: `seed prune failed: ${redactCommandOutput(
        error instanceof Error ? error.message : String(error),
      )}`,
    };
  }
}
