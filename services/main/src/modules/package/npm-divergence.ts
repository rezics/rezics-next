import type { NpmRegistryInstance, NpmRegistryOutcome } from './npm-registry.ts';

// PKG12 explanation over one frozen registry snapshot: a REZICS npm-family receipt versus the native
// npm lockfile (or native error code) produced from the same packument bytes. Physical layout,
// logical instance topology, selection, dependency flags and outcome classes are reported separately.
export type NpmNativeObservation =
  | { status: 'solved'; lock: { lockfileVersion: number; packages: Record<string, NpmNativeLockEntry> } }
  | { status: 'failed'; code: string };
export interface NpmNativeLockEntry {
  name?: string; version?: string; resolved?: string; integrity?: string; link?: boolean;
  dev?: boolean; optional?: boolean; devOptional?: boolean; peer?: boolean;
  dependencies?: Record<string, string>; optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>; devDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}
export type NpmDivergenceKind = 'layout' | 'selection' | 'instance-only-rezics' | 'instance-only-native'
  | 'source' | 'flags' | 'outcome' | 'stricter-admission' | 'failure-class';
export interface NpmDivergence {
  kind: NpmDivergenceKind; path: string | null; name: string; rezics: string | null; native: string | null;
  explanation: string;
}
export interface NpmDivergenceReport {
  profile: 'npm-family-divergence-v1'; strategy: string;
  correspondence: 'identical' | 'logical' | 'divergent' | 'both-failed';
  rezicsStatus: NpmRegistryOutcome['status']; native: string;
  logicalInstances: { rezics: number; native: number; shared: number };
  divergences: NpmDivergence[];
}
/** Native error codes that correspond to one REZICS failure class over the same snapshot. */
const failureClasses: Record<string, string[]> = {
  'unsatisfiable:peer-conflict': ['ERESOLVE'],
  'unsatisfiable:no-matching-version': ['ETARGET'],
  'unsatisfiable:platform': ['EBADPLATFORM'],
  'incomplete-source-data': ['E404', 'E500', 'E503', 'ENOTFOUND', 'ECONNREFUSED'],
  'inconsistent-source-data': ['EINTEGRITY'],
  'unsupported-semantics:override:direct-conflict-EOVERRIDE': ['EOVERRIDE'],
};

interface Logical { path: string; name: string; version: string; kind: 'registry' | 'link' | 'workspace';
  resolved: string | null; integrity: string | null; flags: string; deps: Map<string, string | null> }

function flagText(flags: { dev?: boolean; optional?: boolean; devOptional?: boolean; peer?: boolean }): string {
  const devOptional = !flags.dev && !flags.optional && flags.devOptional;
  return [flags.dev ? 'dev' : '', flags.optional ? 'optional' : '', devOptional ? 'devOptional' : '',
    flags.peer ? 'peer' : ''].filter(Boolean).join(',') || 'prod';
}
function slotName(path: string): string { return path.slice(path.lastIndexOf('node_modules/') + 13); }
function parentOf(path: string, tops: Set<string>): string | null {
  if (tops.has(path) && path !== '') return '';
  const index = path.lastIndexOf('/node_modules/');
  if (index >= 0) return path.slice(0, index);
  return path.startsWith('node_modules/') ? '' : null;
}
/** npm's installation lookup over lock paths: own children, then enclosing packages; workspaces fall back to root. */
function lookupPath(paths: Set<string>, tops: Set<string>, from: string, name: string, peer: boolean): string | null {
  let scope: string | null = peer && !tops.has(from) ? parentOf(from, tops) : from;
  while (scope !== null) {
    const candidate = `${scope ? `${scope}/` : ''}node_modules/${name}`;
    if (paths.has(candidate)) return candidate;
    scope = parentOf(scope, tops);
  }
  return null;
}

function rezicsLogical(outcome: NpmRegistryOutcome): Map<string, Logical> {
  const byPath = new Map(outcome.instances.map(item => [item.path, item]));
  const result = new Map<string, Logical>();
  for (const item of outcome.instances) {
    if (item.kind === 'root') continue;
    const deps = new Map<string, string | null>();
    for (const edge of outcome.edges.filter(edge => edge.from === item.path && edge.type !== 'workspace')) {
      const target = edge.to ? byPath.get(edge.to) : undefined;
      deps.set(edge.name, target ? versionOf(target, byPath) : null);
    }
    result.set(item.path, { path: item.path, name: item.name, version: item.version, kind: item.kind as Logical['kind'],
      resolved: item.kind === 'link' ? item.linkTarget : item.resolved, integrity: item.integrity,
      flags: flagText(item), deps });
  }
  return result;
}
function versionOf(item: NpmRegistryInstance, byPath: Map<string, NpmRegistryInstance>): string {
  const target = item.kind === 'link' && item.linkTarget ? byPath.get(item.linkTarget) ?? item : item;
  return `${target.name}@${target.version}`;
}
function nativeLogical(packages: Record<string, NpmNativeLockEntry>): Map<string, Logical> {
  const paths = new Set(Object.keys(packages).filter(path => path !== ''));
  const tops = new Set(['', ...Object.entries(packages).filter(([path, entry]) => path !== ''
    && !path.includes('node_modules/') && !entry.link).map(([path]) => path)]);
  const identity = (path: string): { name: string; version: string } => {
    const entry = packages[path]!;
    if (entry.link && entry.resolved && packages[entry.resolved]) return identity(entry.resolved);
    return { name: entry.name ?? slotName(path), version: entry.version ?? '0.0.0' };
  };
  const result = new Map<string, Logical>();
  for (const path of paths) {
    const entry = packages[path]!;
    const deps = new Map<string, string | null>();
    const peers = entry.peerDependencies ?? {};
    const declarations: Array<[string, boolean]> = [
      ...Object.keys(peers).map(name => [name, true] as [string, boolean]),
      ...Object.keys({ ...entry.dependencies, ...entry.optionalDependencies,
        ...(tops.has(path) ? entry.devDependencies : {}) }).map(name => [name, false] as [string, boolean]),
    ];
    if (!entry.link) {
      for (const [name, peer] of declarations) {
        const found = lookupPath(paths, tops, path, name, peer && !(name in (entry.dependencies ?? {}))
          && !(name in (entry.optionalDependencies ?? {})));
        deps.set(name, found ? `${identity(found).name}@${identity(found).version}` : null);
      }
    }
    const own = identity(path);
    result.set(path, { path, name: own.name, version: own.version,
      kind: entry.link ? 'link' : tops.has(path) ? 'workspace' : 'registry',
      resolved: entry.resolved ?? null, integrity: entry.integrity ?? null, flags: flagText(entry), deps });
  }
  return result;
}
function signature(item: Logical): string {
  return `${item.kind}:${item.name}@${item.version}{${[...item.deps].sort(([a], [b]) => a < b ? -1 : 1)
    .map(([name, value]) => `${name}=${value ?? '-'}`).join(',')}}`;
}
function count(values: string[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const value of values) map.set(value, (map.get(value) ?? 0) + 1);
  return map;
}

export function explainNpmDivergence(outcome: NpmRegistryOutcome, native: NpmNativeObservation): NpmDivergenceReport {
  const base = { profile: 'npm-family-divergence-v1' as const, strategy: outcome.strategy,
    rezicsStatus: outcome.status, native: native.status === 'solved' ? 'solved' : native.code };
  const failureKey = outcome.status === 'unsatisfiable' ? `unsatisfiable:${outcome.conflict?.kind}`
    : outcome.status === 'unsupported-semantics' ? `unsupported-semantics:${outcome.unsupportedClauses[0]}` : outcome.status;
  if (outcome.status !== 'solved' && native.status === 'failed') {
    const matches = (failureClasses[failureKey] ?? []).includes(native.code);
    return { ...base, correspondence: 'both-failed', logicalInstances: { rezics: 0, native: 0, shared: 0 },
      divergences: matches ? [] : [{ kind: 'failure-class', path: outcome.conflict?.path ?? null,
        name: outcome.conflict?.name ?? '', rezics: failureKey, native: native.code,
        explanation: `both profiles reject the snapshot, but REZICS reports ${failureKey} where npm reports ${native.code}` }] };
  }
  if (outcome.status !== 'solved' || native.status === 'failed') {
    const stricter = outcome.status === 'unsupported-semantics' || outcome.status === 'incomplete-source-data'
      || outcome.status === 'inconsistent-source-data';
    return { ...base, correspondence: 'divergent', logicalInstances: { rezics: outcome.instances.length, native: 0, shared: 0 },
      divergences: [{ kind: outcome.status !== 'solved' && stricter ? 'stricter-admission' : 'outcome',
        path: outcome.conflict?.path ?? null, name: outcome.conflict?.name ?? outcome.issues[0]?.name ?? '',
        rezics: failureKey, native: native.status === 'solved' ? 'solved' : native.code,
        explanation: outcome.status === 'unsupported-semantics'
          ? `REZICS refuses ${outcome.unsupportedClauses[0]} instead of claiming native semantics it does not model`
          : outcome.status === 'incomplete-source-data'
            ? `REZICS treats ${outcome.issues[0]?.detail ?? 'missing evidence'} as incomplete data; npm ${native.status === 'solved' ? 'proceeds' : `fails with ${base.native}`}`
            : outcome.status === 'inconsistent-source-data'
              ? 'REZICS verified artifact bytes against registry SRI; npm lock-only solving fetches no tarball'
              : `REZICS ${failureKey} and npm ${base.native} disagree over the same snapshot` }] };
  }
  const rezics = rezicsLogical(outcome);
  const nativeMap = nativeLogical(native.lock.packages);
  const divergences: NpmDivergence[] = [];
  const rezicsSigs = count([...rezics.values()].map(signature));
  const nativeSigs = count([...nativeMap.values()].map(signature));
  let shared = 0;
  for (const [key, amount] of rezicsSigs) shared += Math.min(amount, nativeSigs.get(key) ?? 0);
  const selectionOf = (path: string) => outcome.instances.find(item => item.path === path)?.selection ?? null;
  for (const path of [...new Set([...rezics.keys(), ...nativeMap.keys()])].sort()) {
    const left = rezics.get(path);
    const right = nativeMap.get(path);
    if (left && right) {
      if (left.name !== right.name || left.version !== right.version) {
        const selection = selectionOf(path);
        divergences.push({ kind: 'selection', path, name: left.name, rezics: `${left.name}@${left.version}`,
          native: `${right.name}@${right.version}`, explanation: selection
            ? `REZICS picked ${left.version} for ${selection.spec} by ${selection.reason}${selection.higherSatisfying.length
              ? ` (higher satisfying: ${selection.higherSatisfying.join(', ')})` : ''}; npm placed ${right.version} here`
            : 'the slot holds different packages in the two layouts' });
        continue;
      }
      if (left.kind !== 'link' && (left.resolved !== right.resolved || left.integrity !== right.integrity)) {
        divergences.push({ kind: 'source', path, name: left.name, rezics: `${left.resolved} ${left.integrity}`,
          native: `${right.resolved} ${right.integrity}`, explanation: 'same version with different recorded source evidence' });
      }
      if (left.flags !== right.flags) {
        divergences.push({ kind: 'flags', path, name: left.name, rezics: left.flags, native: right.flags,
          explanation: 'dependency-type reachability flags differ for the same installed instance' });
      }
      const changed = [...new Set([...left.deps.keys(), ...right.deps.keys()])].sort()
        .filter(name => (left.deps.get(name) ?? null) !== (right.deps.get(name) ?? null));
      if (changed.length) {
        divergences.push({ kind: 'selection', path, name: left.name, rezics: signature(left), native: signature(right),
          explanation: `the same instance resolves ${changed.map(name => `${name} to ${left.deps.get(name) ?? 'nothing'} in REZICS and ${
            right.deps.get(name) ?? 'nothing'} in npm`).join('; ')}` });
      }
    } else if (left) {
      const logicalMatch = (nativeSigs.get(signature(left)) ?? 0) > 0;
      divergences.push({ kind: logicalMatch ? 'layout' : 'instance-only-rezics', path, name: left.name,
        rezics: `${left.name}@${left.version}`, native: null, explanation: logicalMatch
          ? 'npm installs the same logical instance at another path (hoisting difference only)'
          : 'REZICS selects an instance that npm does not install' });
    } else if (right) {
      const logicalMatch = (rezicsSigs.get(signature(right)) ?? 0) > 0;
      divergences.push({ kind: logicalMatch ? 'layout' : 'instance-only-native', path, name: right.name,
        rezics: null, native: `${right.name}@${right.version}`, explanation: logicalMatch
          ? 'REZICS installs the same logical instance at another path (hoisting difference only)'
          : 'npm installs an instance that REZICS does not select' });
    }
  }
  const logical = [...rezicsSigs].every(([key, amount]) => nativeSigs.get(key) === amount)
    && [...nativeSigs].every(([key, amount]) => rezicsSigs.get(key) === amount);
  const correspondence = divergences.length === 0 ? 'identical'
    : logical && divergences.every(item => item.kind === 'layout') ? 'logical' : 'divergent';
  return { ...base, correspondence, logicalInstances: { rezics: rezics.size, native: nativeMap.size, shared },
    divergences };
}

/** Package-manager strategies in the npm family that have no pinned native oracle are refused explicitly. */
export const npmFamilyStrategyStatus = {
  'npm-hoisted': 'qualified-against-npm-11.19.1',
  'npm-nested': 'qualified-against-npm-11.19.1',
  'npm-shallow': 'qualified-against-npm-11.19.1',
  'npm-linked': 'unsupported-no-oracle',
  'pnpm-isolated': 'unsupported-no-oracle',
  'yarn-node-modules': 'unsupported-no-oracle',
  'yarn-pnp': 'unsupported-no-oracle',
} as const;
