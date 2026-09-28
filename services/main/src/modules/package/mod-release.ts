import { ModProfileInvalid, type ModRelation, type ModRequest } from './mod-profile.ts';

/** What one disclosed release may carry, and how many a listing or page reads (migration 815). */
export const MOD_RELEASE_COST = { pageSize: 20, listingWorks: 64, releasesPerListing: 16, dependencies: 32,
  browseReleasesPerWork: 128, changelogCharacters: 4000, rangeCharacters: 128, releaseBytes: 16_384 } as const;

export type ModLoader = 'Fabric' | 'Forge' | 'NeoForge';
/** Where a release runs, as its manifest declares it; null when the manifest does not say. */
export type ModEnvironment = 'client' | 'server' | 'client-and-server';

/** A mod a release declares beside it, grouped as a player must, may or must not install it. */
export interface ModReleaseDependency {
  /** The native mod ID (`fabric-api`). */
  id: string;
  requirement: 'required' | 'optional' | 'incompatible' | 'embedded';
  /** The version range as the manifest writes it; alternatives are joined with ` || `. */
  range: string | null;
  /** The only side it applies on, or null for both. */
  side: 'client' | 'server' | null;
}

/**
 * One release of a mod Work: the public manifest facts of one verified native
 * receipt, disclosed by the Work's owner when they bind it. Releases bound
 * before migration 815 disclosed game, loader and version only, so `mod`,
 * `environment` and `dependencies` are null ("not disclosed"), never empty.
 */
export interface ModRelease {
  profile: 'mod-release-v1';
  mod: { id: string; ecosystem: 'fabric' | 'forge' | 'neoforge' } | null;
  version: string | null;
  game: 'Minecraft';
  gameVersions: string[];
  loaders: ModLoader[];
  environment: ModEnvironment | null;
  dependencies: ModReleaseDependency[] | null;
  /** The owner's notes for this release, as plain text. */
  changelog: string | null;
  capturedAt: string;
}

const LOADERS = { fabric: 'Fabric', forge: 'Forge', neoforge: 'NeoForge' } as const;
/** Targets the loader or game provides; a release shows them as compatibility, not dependencies. */
const RUNTIME = new Set(['minecraft', 'java', 'fabricloader', 'fabric-loader', 'forge', 'neoforge']);

function requirement(edge: ModRelation): ModReleaseDependency['requirement'] | null {
  if (edge.strength === 'embedded') return 'embedded';
  switch (edge.kind.split(':')[0]) {
    case 'depends': case 'required': return 'required';
    case 'recommends': case 'suggests': case 'optional': return 'optional';
    case 'breaks': case 'conflicts': case 'incompatible': case 'discouraged': return 'incompatible';
    default: return null;
  }
}

function range(value: ModRelation['range']): string | null {
  const text = Array.isArray(value) ? value.join(' || ') : value;
  if (!text || text === '*') return null;
  if (text.length > MOD_RELEASE_COST.rangeCharacters) throw new ModProfileInvalid('dependency range is too long to disclose');
  return text;
}

/** The dependencies the root mod itself declares, each once, required first. */
export function declaredDependencies(root: string, relations: readonly ModRelation[]): ModReleaseDependency[] {
  const found = new Map<string, ModReleaseDependency>();
  for (const edge of relations) {
    const kind = requirement(edge);
    if (edge.from !== root || !kind || RUNTIME.has(edge.to) || edge.to.startsWith('feature:')) continue;
    const side = edge.side === 'CLIENT' ? 'client' : edge.side === 'SERVER' ? 'server' : null;
    const key = `${kind} ${edge.to}`;
    if (!found.has(key)) found.set(key, { id: edge.to, requirement: kind, range: range(edge.range), side });
  }
  if (found.size > MOD_RELEASE_COST.dependencies) throw new ModProfileInvalid('too many dependencies to disclose');
  const order = ['required', 'optional', 'incompatible', 'embedded'] as const;
  return [...found.values()].sort((a, b) => order.indexOf(a.requirement) - order.indexOf(b.requirement)
    || a.id.localeCompare(b.id));
}

type Manifest = { version?: unknown; environment?: unknown; clientSideOnly?: unknown;
  mods?: Array<{ modId?: unknown; version?: unknown }> };

/**
 * The public facts of a valid receipt's root manifest. Only a valid Minecraft
 * capture with a game version becomes a release; everything else stays private.
 */
export function modRelease(receipt: { request: ModRequest; outcome: { selection: string; ordering: string;
  relations: ModRelation[] }; createdAt: string }, changelog: string | null = null): ModRelease {
  const { request, outcome } = receipt;
  if (outcome.selection !== 'valid' || outcome.ordering !== 'valid'
    || !['fabric', 'forge', 'neoforge'].includes(request.ecosystem)
    || !request.runtime?.gameVersion || request.runtime.gameVersion.length > 32) {
    throw new ModProfileInvalid('Only a valid Minecraft capture with a game version can be bound');
  }
  const notes = changelog?.replace(/\r\n?/g, '\n').trim() || null;
  if (notes && notes.length > MOD_RELEASE_COST.changelogCharacters) throw new ModProfileInvalid('changelog is too long');
  const ecosystem = request.ecosystem as keyof typeof LOADERS;
  const root = request.captures.find(capture => capture.identity === request.root
    && capture.surface === 'manifest' && capture.status === 'observed');
  let version: string | null = null;
  let environment: ModEnvironment | null = null;
  if (root?.bytesBase64) {
    const raw = Buffer.from(root.bytesBase64, 'base64').toString('utf8');
    const document = (ecosystem === 'fabric' ? JSON.parse(raw) : Bun.TOML.parse(raw)) as Manifest;
    const declared = ecosystem === 'fabric' ? document.version
      : document.mods?.find(mod => mod.modId === request.root)?.version;
    if (typeof declared === 'string' && declared.length <= 64 && !declared.includes('${')) version = declared;
    if (ecosystem === 'fabric') {
      environment = document.environment === 'client' ? 'client' : document.environment === 'server' ? 'server'
        : 'client-and-server';
    } else if (ecosystem === 'forge' && document.clientSideOnly === true) environment = 'client';
  }
  const release: ModRelease = { profile: 'mod-release-v1', mod: { id: request.root, ecosystem }, version,
    game: 'Minecraft', gameVersions: [request.runtime.gameVersion], loaders: [LOADERS[ecosystem]], environment,
    dependencies: declaredDependencies(request.root, outcome.relations), changelog: notes,
    capturedAt: receipt.createdAt };
  if (Buffer.byteLength(JSON.stringify(release)) > MOD_RELEASE_COST.releaseBytes) {
    throw new ModProfileInvalid('release is too large to disclose');
  }
  return release;
}

/** Game versions newest first: numeric segments compare as numbers (`1.21.10` after `1.21.9`). */
export function newestVersionsFirst(a: string, b: string): number {
  const left = a.split(/[.-]/), right = b.split(/[.-]/);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const x = left[index] ?? '', y = right[index] ?? '';
    const difference = /^\d+$/.test(x) && /^\d+$/.test(y) ? Number(y) - Number(x) : y.localeCompare(x);
    if (difference) return difference;
  }
  return 0;
}

/** A mod Work as a listing shows it: what its disclosed releases run on together, and its newest release. */
export interface ModListing {
  profile: 'mod-work-card-v2';
  game: 'Minecraft';
  /** Every game version its newest releases run on, newest first. */
  gameVersions: string[];
  loaders: ModLoader[];
  /** The newest release's environment. */
  environment: ModEnvironment | null;
  latestRelease: string | null;
  /** When the newest release was disclosed: the mod's last update. */
  updatedAt: string;
  /** Browse's exact release for its chosen Conditions; absent on home modules. */
  selected?: { version: string | null; gameVersions: string[]; loaders: ModLoader[];
    environment: ModEnvironment | null; side: 'client' | 'server'; publishedAt: string;
    channel: 'release' | 'beta' | 'alpha' | null;
    dependencies: ModReleaseDependency[] | null; state: 'compatible' | 'stale' } | null;
}

/** A bounded browse row. Its fields all belong to the same bound release. */
export type ModBrowseRelease = Pick<ModRelease, 'version' | 'gameVersions' | 'loaders' | 'environment' | 'dependencies'>
  & { publishedAt: string };

export interface ModSelection {
  gameVersions?: readonly string[];
  loaders?: readonly ModLoader[];
  environments?: readonly ('client' | 'server')[];
  requiredDependencies?: readonly string[];
}

export function matchesModRelease(release: ModBrowseRelease, selection: ModSelection): boolean {
  return (!selection.gameVersions?.length || selection.gameVersions.some(value => release.gameVersions.includes(value)))
    && (!selection.loaders?.length || selection.loaders.some(value => release.loaders.includes(value)))
    && (!selection.environments?.length || selection.environments.some(value =>
      release.environment === value || release.environment === 'client-and-server'))
    && (!selection.requiredDependencies?.length || selection.requiredDependencies.some(value =>
      release.dependencies?.some(item => item.requirement === 'required' && item.id === value)));
}

/** `publishedAt` and dependencies stay bound to the selected release, never to a different loader's newest. */
export function selectModRelease(releases: readonly ModBrowseRelease[], selection: ModSelection): ModBrowseRelease | null {
  return releases.find(release => matchesModRelease(release, selection)) ?? null;
}

/** A complete environment either identifies one release, has missing side evidence, or proves no match. */
export function modCompatibility(releases: readonly ModBrowseRelease[],
  selection: Required<Pick<ModSelection, 'gameVersions' | 'loaders' | 'environments'>>) {
  const selected = selectModRelease(releases, selection);
  if (selected) return { state: selected === releases[0] ? 'compatible' as const : 'stale' as const,
    release: selected };
  if (!releases.length || releases.some(release => release.environment === null
    && selection.gameVersions.some(value => release.gameVersions.includes(value))
    && selection.loaders.some(value => release.loaders.includes(value)))) {
    return { state: 'unknown' as const, release: null };
  }
  return { state: 'incompatible' as const, release: null };
}

/** Only conventional numeric versions prove a release channel; an explicit alpha/beta suffix takes precedence. */
export function modReleaseChannel(version: string | null): 'release' | 'beta' | 'alpha' | null {
  if (!version) return null;
  if (/(?:^|[.\-+_])alpha(?:[.\-+_]|\d|$)/i.test(version)) return 'alpha';
  if (/(?:^|[.\-+_])beta(?:[.\-+_]|\d|$)/i.test(version)) return 'beta';
  return /^\d+(?:\.\d+){1,3}$/.test(version) ? 'release' : null;
}

/** Folds a Work's releases, newest first, into its listing card. */
export function modListing(releases: readonly { release: Pick<ModRelease,
  'gameVersions' | 'loaders' | 'environment' | 'version'>; boundAt: string }[]): ModListing | null {
  const [newest] = releases;
  if (!newest) return null;
  const versions = new Set(releases.flatMap(item => item.release.gameVersions));
  const loaders = new Set(releases.flatMap(item => item.release.loaders));
  return { profile: 'mod-work-card-v2', game: 'Minecraft',
    gameVersions: [...versions].sort(newestVersionsFirst).slice(0, MOD_RELEASE_COST.releasesPerListing),
    loaders: (['Fabric', 'Forge', 'NeoForge'] as const).filter(loader => loaders.has(loader)),
    environment: newest.release.environment, latestRelease: newest.release.version, updatedAt: newest.boundAt };
}
