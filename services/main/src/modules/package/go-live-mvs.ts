import { compareGoLanguage, compareGoVersions, GO_MODULE_VERSION, parseGoModFile,
  type GoModFile, type GoModRetraction } from './go-modfile.ts';

// Provider-derived Go module graph for one pruned (go >= 1.17) main module,
// following cmd/go's readModGraph: each root's go.mod is loaded; requirements of a
// pruned module join the graph without loading their go.mod; a go.mod without
// pruning (go < 1.17 or absent) is expanded transitively. Roots are stabilized at
// their selected versions as `go list -mod=mod -m all` does. Retractions come from
// the go.mod of each selected path's latest version (its @v/list, else @latest),
// which also yields the `-u` upgrade that skips retracted versions. Every provider
// read goes through one loader, so a live proxy and a retained capture are
// interchangeable and missing data is never read as an empty requirement set.

export const GO_PROXY_ORIGIN = 'https://proxy.golang.org/';
export const GO_LIVE_TOOLCHAIN = '1.27.1';

export type GoLiveStatus = 'solved' | 'incomplete-source-data' | 'unsupported-semantics'
  | 'budget-exhausted' | 'cancelled';
export interface GoLiveLimits { maxFetches: number; maxBytes: number; maxFileBytes: number;
  maxModules: number; maxRounds: number }
export const GO_LIVE_LIMITS: GoLiveLimits = { maxFetches: 2_048, maxBytes: 32 * 1024 * 1024,
  maxFileBytes: 1024 * 1024, maxModules: 1_024, maxRounds: 16 };
/** Reads one proxy-relative path such as `golang.org/x/net/@v/v0.1.0.mod`; null is 404/410. */
export type GoProxyLoader = (path: string, signal?: AbortSignal) => Promise<Uint8Array | null>;
export interface GoLiveInput { mainModule: string; loader: GoProxyLoader;
  limits?: Partial<GoLiveLimits>; signal?: AbortSignal; deadline?: number; now?: () => number }
export interface GoLiveModule { path: string; version: string; goVersion: string | null;
  retracted: string[] | null; update: string | null; latest: string | null }
export interface GoLiveCost { fetches: number; bytes: number; modFiles: number; lists: number;
  graphRounds: number; graphVisits: number }
export interface GoLiveOutcome {
  status: GoLiveStatus;
  mainModule: string | null;
  goDirective: string | null;
  roots: Array<{ path: string; version: string }>;
  buildList: GoLiveModule[];
  loaded: string[];
  missing: string[];
  unsupportedClauses: string[];
  ignoredClauses: string[];
  budget: { kind: 'fetches' | 'bytes' | 'modules' | 'rounds' | 'time'; limit: number; used: number } | null;
  cost: GoLiveCost;
}

export class GoLiveInvalid extends Error {}
class Unsupported extends Error {}
class Budget extends Error {
  constructor(readonly kind: NonNullable<GoLiveOutcome['budget']>['kind'], readonly limit: number,
    readonly used: number) { super(`Go ${kind} budget exhausted`); }
}
class Cancelled extends Error {}

/** cmd/go module path escaping for proxy URLs: upper-case letters become `!` + lower-case. */
export function escapeGoModulePath(value: string): string {
  return value.replace(/[A-Z]/g, letter => `!${letter.toLowerCase()}`);
}

/** Fixed-origin bounded proxy reader for proxy.golang.org. */
export function goProxyLoader(origin = GO_PROXY_ORIGIN, fetcher: typeof fetch = fetch,
  maxFileBytes = GO_LIVE_LIMITS.maxFileBytes): GoProxyLoader {
  const base = new URL(origin);
  if (base.protocol !== 'https:' || base.pathname !== '/' || base.search || base.username) {
    throw new GoLiveInvalid('Go proxy origin must be a fixed HTTPS origin');
  }
  return async (path, signal) => {
    if (!/^[a-z0-9!._~\/+@-]+$/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..')) {
      throw new GoLiveInvalid(`invalid Go proxy path ${path}`);
    }
    const response = await fetcher(new URL(path, base), { redirect: 'error', signal });
    if (response.status === 404 || response.status === 410) return null;
    if (!response.ok) throw new Error(`Go proxy ${path}: HTTP ${response.status}`);
    const declared = Number(response.headers.get('content-length') ?? '0');
    if (declared > maxFileBytes) throw new Budget('bytes', maxFileBytes, declared);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > maxFileBytes) throw new Budget('bytes', maxFileBytes, bytes.length);
    return bytes;
  };
}

const key = (path: string, version: string) => `${path}@${version}`;
const isRelease = (version: string) => !GO_MODULE_VERSION.exec(version)![4];
const pseudo = /^v\d+\.(?:0\.0-|\d+\.\d+-(?:[^+]*\.)?0\.)\d{14}-[0-9a-f]{12}(?:\+incompatible)?$/;

function decode(bytes: Uint8Array, what: string): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new Unsupported(`${what}: not UTF-8`); }
}

export async function solveGoLiveGraph(input: GoLiveInput): Promise<GoLiveOutcome> {
  const limits = { ...GO_LIVE_LIMITS, ...input.limits };
  const now = input.now ?? (() => performance.now());
  const cost: GoLiveCost = { fetches: 0, bytes: 0, modFiles: 0, lists: 0, graphRounds: 0, graphVisits: 0 };
  const missing = new Set<string>();
  const unsupported = new Set<string>();
  const ignored = new Set<string>();
  const loadedMods = new Set<string>();
  let main: GoModFile | null = null;
  let roots = new Map<string, string>();
  const base = (status: GoLiveStatus): GoLiveOutcome => ({ status, mainModule: main?.module ?? null,
    goDirective: main?.go ?? null, roots: [...roots].map(([path, version]) => ({ path, version })),
    buildList: [], loaded: [...loadedMods].sort(), missing: [...missing].sort(),
    unsupportedClauses: [...unsupported].sort(), ignoredClauses: [...ignored].sort(),
    budget: null, cost });
  const check = () => {
    if (input.signal?.aborted) throw new Cancelled('Go resolution cancelled');
    if (input.deadline !== undefined && now() >= input.deadline) {
      throw new Budget('time', input.deadline, Math.ceil(now()));
    }
  };
  const cache = new Map<string, Promise<Uint8Array | null>>();
  const fetchPath = (path: string): Promise<Uint8Array | null> => {
    const known = cache.get(path);
    if (known) return known;
    const pending = (async () => {
      check();
      if (cost.fetches >= limits.maxFetches) throw new Budget('fetches', limits.maxFetches, cost.fetches + 1);
      cost.fetches++;
      const bytes = await input.loader(path, input.signal);
      check();
      if (bytes) {
        cost.bytes += bytes.length;
        if (bytes.length > limits.maxFileBytes || cost.bytes > limits.maxBytes) {
          throw new Budget('bytes', limits.maxBytes, cost.bytes);
        }
      } else missing.add(path);
      return bytes;
    })();
    cache.set(path, pending);
    return pending;
  };
  const summaries = new Map<string, GoModFile | null>();
  const summary = async (path: string, version: string, graphNode = true): Promise<GoModFile | null> => {
    const id = key(path, version);
    if (summaries.has(id)) return summaries.get(id)!;
    const bytes = await fetchPath(`${escapeGoModulePath(path)}/@v/${escapeGoModulePath(version)}.mod`);
    let parsed: GoModFile | null = null;
    if (bytes) {
      cost.modFiles++;
      loadedMods.add(id);
      parsed = parseGoModFile(decode(bytes, id), 'lax');
      for (const error of parsed.errors) unsupported.add(`${id}: ${error}`);
      for (const clause of parsed.ignored) ignored.add(`${id}: ${clause}`);
      if (parsed.errors.length) parsed = null;
      else if (parsed.module !== null && parsed.module !== path) {
        unsupported.add(`${id}: go.mod declares ${parsed.module}`);
        parsed = null;
      } else if (graphNode && parsed.go !== null && compareGoLanguage(parsed.go, GO_LIVE_TOOLCHAIN) > 0) {
        unsupported.add(`${id}: requires go ${parsed.go} beyond pinned go${GO_LIVE_TOOLCHAIN}`);
        parsed = null;
      }
    }
    summaries.set(id, parsed);
    return parsed;
  };
  const pruned = (file: GoModFile) => file.go !== null && compareGoLanguage(file.go, '1.17') >= 0;

  try {
    main = parseGoModFile(input.mainModule, 'strict');
    if (main.errors.length) throw new GoLiveInvalid(`invalid main go.mod: ${main.errors.join('; ')}`);
    if (main.module === null) throw new GoLiveInvalid('main go.mod has no module directive');
    if (main.go === null || !pruned(main)) {
      throw new Unsupported('main module go directive below 1.17 is outside the pruned profile');
    }
    if (compareGoLanguage(main.go, GO_LIVE_TOOLCHAIN) > 0) {
      throw new Unsupported(`main module requires go ${main.go} beyond pinned go${GO_LIVE_TOOLCHAIN}`);
    }
    if (main.replace.length || main.exclude.length) {
      throw new Unsupported('main-module replace/exclude belong to the captured directive profiles');
    }
    for (const item of main.require) {
      if (roots.has(item.path)) throw new GoLiveInvalid(`duplicate main requirement ${item.path}`);
      roots.set(item.path, item.version);
    }

    let graph = new Map<string, string>();
    for (let round = 1; ; round++) {
      if (round > limits.maxRounds) throw new Budget('rounds', limits.maxRounds, round);
      cost.graphRounds = round;
      graph = new Map();
      const note = (path: string, version: string) => {
        const current = graph.get(path);
        if (!current || compareGoVersions(version, current) > 0) graph.set(path, version);
        if (graph.size > limits.maxModules) throw new Budget('modules', limits.maxModules, graph.size);
      };
      const seen = { pruned: new Set<string>(), unpruned: new Set<string>() };
      const queue: Array<{ path: string; version: string; mode: 'pruned' | 'unpruned' }> = [];
      for (const [path, version] of roots) { note(path, version); queue.push({ path, version, mode: 'pruned' }); }
      for (let at = 0; at < queue.length; at++) {
        const item = queue[at]!;
        const id = key(item.path, item.version);
        if (seen[item.mode].has(id)) continue;
        seen[item.mode].add(id);
        cost.graphVisits++;
        const file = await summary(item.path, item.version);
        if (!file) continue;
        const next = item.mode === 'unpruned' || !pruned(file) ? 'unpruned' : 'pruned';
        for (const requirement of file.require) {
          note(requirement.path, requirement.version);
          if (item.mode !== 'pruned' || !pruned(file)) {
            queue.push({ path: requirement.path, version: requirement.version, mode: next });
          }
        }
      }
      if (missing.size || unsupported.size) break;
      let changed = false;
      const next = new Map<string, string>();
      for (const path of roots.keys()) {
        const selected = graph.get(path)!;
        if (selected !== roots.get(path)) changed = true;
        next.set(path, selected);
      }
      if (!changed) break;
      roots = next;
    }
    if (unsupported.size) return base('unsupported-semantics');
    if (missing.size) return base('incomplete-source-data');

    const buildList: GoLiveModule[] = [];
    for (const [path, version] of [...graph].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
      if (path === main.module) continue;
      const own = await summary(path, version);
      const escaped = escapeGoModulePath(path);
      const listBytes = await fetchPath(`${escaped}/@v/list`);
      // An absent list leaves retraction unknown: recorded missing, never "not retracted".
      if (!listBytes) continue;
      cost.lists++;
      const versions = decode(listBytes, `${path} list`).split('\n').map(line => line.trim())
        .filter(Boolean).filter(item => GO_MODULE_VERSION.test(item) && !pseudo.test(item));
      if (versions.some(item => item.endsWith('+incompatible'))) {
        unsupported.add(`${path}: +incompatible latest selection is outside this profile`);
        continue;
      }
      let latest: string | null = null;
      const releases = versions.filter(isRelease);
      const pool = releases.length ? releases : versions;
      for (const item of pool) if (!latest || compareGoVersions(item, latest) > 0) latest = item;
      if (!latest) {
        const info = await fetchPath(`${escaped}/@latest`);
        if (info) {
          try { latest = (JSON.parse(decode(info, `${path} @latest`)) as { Version?: string }).Version ?? null; }
          catch { unsupported.add(`${path}: malformed @latest`); }
          if (latest !== null && !GO_MODULE_VERSION.test(latest)) {
            unsupported.add(`${path}: malformed @latest version`);
            latest = null;
          }
        }
      }
      let retractions: GoModRetraction[] = [];
      if (latest) {
        const latestFile = await summary(path, latest, false);
        if (!latestFile) { buildList.push({ path, version, goVersion: own?.go ?? null,
          retracted: null, update: null, latest }); continue; }
        retractions = latestFile.retract;
      }
      const retractedBy = (candidate: string) => retractions.filter(item =>
        compareGoVersions(item.low, candidate) <= 0 && compareGoVersions(candidate, item.high) <= 0);
      const matched = retractedBy(version);
      const rationales = matched.map(item => item.rationale).filter(Boolean);
      // An untagged module's only upgrade candidate is its @latest pseudo-version.
      const candidates = versions.length ? versions : latest ? [latest] : [];
      const allowed = candidates.filter(item => !retractedBy(item).length);
      const allowedReleases = allowed.filter(isRelease);
      let best: string | null = null;
      for (const item of allowedReleases.length ? allowedReleases : allowed) {
        if (!best || compareGoVersions(item, best) > 0) best = item;
      }
      buildList.push({ path, version, goVersion: own?.go ?? null,
        retracted: matched.length ? (rationales.length ? rationales : ['retracted by module author']) : null,
        update: best && compareGoVersions(best, version) > 0 ? best : null, latest });
    }
    if (unsupported.size) return base('unsupported-semantics');
    if (missing.size) return base('incomplete-source-data');
    return { ...base('solved'), buildList };
  } catch (error) {
    if (error instanceof Budget) return { ...base('budget-exhausted'),
      budget: { kind: error.kind, limit: error.limit, used: error.used } };
    if (error instanceof Cancelled || (input.signal?.aborted && error instanceof Error
      && error.name === 'AbortError')) return base('cancelled');
    if (error instanceof Unsupported) { unsupported.add(error.message); return base('unsupported-semantics'); }
    throw error;
  }
}
