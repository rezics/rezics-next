import { npmSha, npmStable, npmSnapshotSyntax, type NpmBytes, type NpmEdge,
  type NpmInstance, type NpmIssue, type NpmOutcome, type NpmPeerHost } from './npm-lock.ts';

const { object, keys, decode, parseJson, name, version, location, provenance,
  dependencyMap, invalid, Unsupported, Budget, MAX_BYTES } = npmSnapshotSyntax;
export interface NpmTarget { os: string; cpu: string }
export interface NpmPlatformRequest { profile: 'npm-lock-v3-topology-v2'; npmVersion: string;
  policy: string; target: NpmTarget; manifest: NpmBytes; lock: NpmBytes }
export interface NpmPlatformPeerHost extends NpmPeerHost { optional: boolean }
export interface NpmPlatformInstance extends Omit<NpmInstance, 'peerHosts'> {
  peerHosts: NpmPlatformPeerHost[]; optional: boolean; os: string[] | null; cpu: string[] | null }
export interface NpmPlatformEdge extends NpmEdge { optional: boolean }
export interface NpmPlatformIssue extends Omit<NpmIssue, 'kind'> {
  kind: NpmIssue['kind'] | 'optional-flag-mismatch' | 'platform-incompatible' }
export interface NpmOmittedInstance { id: string; path: string; reason: 'platform'; causePath: string }
export interface NpmOmittedEdge { from: string; path: string; name: string; specifier: string;
  kind: NpmEdge['kind']; optional: boolean; to: string | null; foundPath: string | null;
  reason: 'absent-optional' | 'platform' }
export interface NpmPlatformOutcome extends Omit<NpmOutcome, 'instances' | 'edges' | 'issues' | 'cost'> {
  target: NpmTarget; instances: NpmPlatformInstance[]; edges: NpmPlatformEdge[]; issues: NpmPlatformIssue[];
  activeInstances: string[]; activeEdges: NpmPlatformEdge[];
  omittedInstances: NpmOmittedInstance[]; omittedEdges: NpmOmittedEdge[];
  cost: NpmOutcome['cost'] & { graphVisits: number } }
interface Requirement { kind: NpmEdge['kind']; name: string; specifier: string; optional: boolean }
interface Node extends NpmPlatformInstance { parent: string | null; requirements: Requirement[];
  declaredOptional: boolean | undefined }
interface Link { from: Node; to: Node; requirement: Requirement }

function selector(raw: unknown, field: 'os' | 'cpu'): string[] | null {
  if (raw === undefined) return null;
  if (typeof raw !== 'string' && !Array.isArray(raw)) invalid(`malformed npm ${field} selector`);
  const tokens = typeof raw === 'string' ? [raw] : raw as unknown[];
  if (tokens.length > 16) throw new Budget('npm platform selector limit');
  const known = field === 'os' ? ['linux', 'win32'] : ['x64', 'arm64'];
  for (const token of tokens) {
    if (typeof token !== 'string' || !/^!?[a-z][a-z0-9_-]{0,31}$/.test(token)) {
      return invalid(`malformed npm ${field} selector token`);
    }
    if (!known.includes(token.replace(/^!/, '')) && !(token === 'any' && tokens.length === 1)) {
      throw new Unsupported(`unsupported npm ${field} selector`);
    }
  }
  return tokens as string[];
}
function matches(value: string, tokens: string[] | null): boolean {
  return tokens === null || tokens.length === 1 && tokens[0] === 'any'
    || !tokens.includes(`!${value}`) && (tokens.every(token => token.startsWith('!')) || tokens.includes(value));
}
function fields(raw: Record<string, unknown>, root: boolean): void {
  keys(raw, ['name', 'version', 'dependencies', 'optionalDependencies', 'peerDependencies',
    'peerDependenciesMeta', 'os', 'cpu', 'license', ...(root ? ['private'] : ['resolved', 'integrity', 'peer', 'optional'])]);
  if (raw.license !== undefined && typeof raw.license !== 'string') invalid('malformed license metadata');
  for (const key of ['private', 'peer', 'optional']) {
    if (raw[key] !== undefined && typeof raw[key] !== 'boolean') invalid(`malformed ${key} metadata`);
  }
}

export function validateNpmPlatformSnapshot(request: NpmPlatformRequest): NpmPlatformOutcome {
  const envelope = object(request);
  if (Object.keys(envelope).sort().join(',') !== 'lock,manifest,npmVersion,policy,profile,target'
    || request.profile !== 'npm-lock-v3-topology-v2'
    || typeof request.npmVersion !== 'string' || !request.npmVersion || request.npmVersion.length > 32
    || typeof request.policy !== 'string' || !request.policy || request.policy.length > 64) invalid('malformed npm request');
  const target = object(request.target);
  if (Object.keys(target).sort().join(',') !== 'cpu,os'
    || [target.os, target.cpu].some(value => typeof value !== 'string' || !value || value.length > 32)) {
    invalid('malformed npm target');
  }
  const manifestText = decode(request.manifest);
  const lockText = decode(request.lock);
  const outcome: NpmPlatformOutcome = { status: 'validated', target: { ...request.target },
    lockId: `urn:rezics:npm-lock:${npmSha(npmStable(request))}`, provenance: 'caller-supplied',
    lockfileVersion: null, instances: [], edges: [], issues: [], unsupportedClauses: [], budgetReason: null,
    activeInstances: [], activeEdges: [], omittedInstances: [], omittedEdges: [],
    cost: { inputBytes: Buffer.byteLength(manifestText) + Buffer.byteLength(lockText),
      nodeCount: 0, edgeCount: 0, ancestorLookups: 0, graphVisits: 0 } };
  const visit = () => { if (++outcome.cost.graphVisits > 65_536) throw new Budget('npm graph visit limit'); };
  try {
    if (Buffer.byteLength(manifestText) > MAX_BYTES || Buffer.byteLength(lockText) > MAX_BYTES) {
      throw new Budget('npm raw file byte limit');
    }
    const manifest = parseJson(manifestText);
    const lock = parseJson(lockText);
    if (request.npmVersion !== '11.19.1' || request.policy !== 'literal-sources-optional-platform-v2') {
      throw new Unsupported('unsupported npm version or topology policy');
    }
    if (!['linux', 'win32'].includes(target.os as string) || !['x64', 'arm64'].includes(target.cpu as string)) {
      throw new Unsupported('unsupported npm target environment');
    }
    fields(manifest, true);
    name(manifest.name); version(manifest.version);
    selector(manifest.os, 'os'); selector(manifest.cpu, 'cpu');
    keys(lock, ['name', 'version', 'lockfileVersion', 'requires', 'packages']);
    if (!Number.isSafeInteger(lock.lockfileVersion)) invalid('malformed npm lockfile version');
    outcome.lockfileVersion = lock.lockfileVersion as number;
    if (lock.lockfileVersion !== 3) throw new Unsupported('only npm lockfile version 3 is admitted');
    if (lock.requires !== undefined && lock.requires !== true) throw new Unsupported('unsupported lock requires flag');
    const packages = object(lock.packages);
    const paths = Object.keys(packages).sort();
    outcome.cost.nodeCount = Math.min(paths.length, 130);
    if (paths.length > 129) throw new Budget('npm locked package limit');
    if (!Object.hasOwn(packages, '')) invalid('npm lock is missing its root');
    const root = object(packages['']);
    if (lock.name !== manifest.name || lock.version !== manifest.version
      || root.name !== manifest.name || root.version !== manifest.version
      || ['dependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta'].some(field =>
        npmStable(dependencyMap(root[field])) !== npmStable(dependencyMap(manifest[field])))
      || ['os', 'cpu'].some(field => npmStable(root[field] ?? null) !== npmStable(manifest[field] ?? null))) {
      invalid('npm manifest and lock root disagree');
    }
    const nodes = new Map<string, Node>();
    for (const path of paths) {
      const raw = object(packages[path]);
      fields(raw, path === '');
      const slot = path === '' ? { name: name(raw.name), parent: null } : location(path);
      if (raw.name !== undefined && name(raw.name) !== slot.name) throw new Unsupported('npm package alias');
      const pkgVersion = version(raw.version);
      const resolved = path ? provenance(raw.resolved, 'resolved') : null;
      const integrity = path ? provenance(raw.integrity, 'integrity') : null;
      if (path && (!resolved || !integrity)) outcome.issues.push({ kind: 'missing-provenance',
        path, name: slot.name, specifier: null, foundPath: null });
      const meta = dependencyMap(raw.peerDependenciesMeta);
      const peers = dependencyMap(raw.peerDependencies);
      for (const peer of Object.keys(meta)) {
        name(peer);
        if (!Object.hasOwn(peers, peer)) invalid('npm optional peer metadata has no declared peer');
        const value = object(meta[peer]);
        keys(value, ['optional']);
        if (value.optional !== undefined && typeof value.optional !== 'boolean') invalid('malformed optional peer metadata');
      }
      const requirements: Requirement[] = [];
      const names = new Set<string>();
      for (const [field, kind] of [['dependencies', 'dependency'], ['optionalDependencies', 'dependency'],
        ['peerDependencies', 'peer']] as const) {
        const map = dependencyMap(raw[field]);
        for (const depName of Object.keys(map).sort()) {
          if (++outcome.cost.edgeCount > 256) throw new Budget('npm dependency edge limit');
          name(depName);
          if (names.has(depName)) throw new Unsupported('overlapping dependency declarations');
          names.add(depName);
          const optional = field === 'optionalDependencies'
            || kind === 'peer' && Object.hasOwn(meta, depName) && object(meta[depName]).optional === true;
          requirements.push({ kind, name: depName, specifier: version(map[depName]), optional });
        }
      }
      const id = `urn:rezics:npm-instance:${npmSha(npmStable([outcome.lockId, path,
        slot.name, pkgVersion, resolved, integrity]))}`;
      nodes.set(path, { id, path, name: slot.name, version: pkgVersion, resolved, integrity,
        parent: slot.parent, peerHosts: [], requirements, optional: true,
        declaredOptional: raw.optional as boolean | undefined, os: selector(raw.os, 'os'), cpu: selector(raw.cpu, 'cpu') });
    }
    const links: Link[] = [];
    const outgoing = new Map<string, Link[]>(paths.map(path => [path, []]));
    const incoming = new Map<string, Link[]>(paths.map(path => [path, []]));
    const absent: NpmOmittedEdge[] = [];
    for (const node of nodes.values()) {
      if (node.parent !== null && !nodes.has(node.parent)) outcome.issues.push({ kind: 'missing-parent',
        path: node.path, name: node.name, specifier: null, foundPath: node.parent });
      for (const requirement of node.requirements) {
        let cursor: string | null = node.path;
        let to: Node | undefined;
        while (cursor !== null) {
          if (++outcome.cost.ancestorLookups > 4096) throw new Budget('npm ancestor lookup limit');
          to = nodes.get(`${cursor ? `${cursor}/` : ''}node_modules/${requirement.name}`);
          if (to) break;
          cursor = nodes.get(cursor)?.parent ?? null;
        }
        const issue = { path: node.path, name: requirement.name, specifier: requirement.specifier, foundPath: to?.path ?? null };
        if (!to) {
          if (requirement.optional) absent.push({ from: node.id, path: node.path, ...requirement,
            to: null, foundPath: null, reason: 'absent-optional' });
          else outcome.issues.push({ ...issue, kind: requirement.kind === 'peer' ? 'missing-peer' : 'missing-dependency' });
          continue;
        }
        if (requirement.kind === 'peer' && node.path !== '' && to.parent === node.path) {
          outcome.issues.push({ ...issue, kind: 'peer-local' });
        } else if (to.version !== requirement.specifier) outcome.issues.push({ ...issue, kind: 'version-mismatch' });
        const link = { from: node, to, requirement };
        links.push(link); outgoing.get(node.path)!.push(link); incoming.get(to.path)!.push(link);
        if (requirement.kind === 'peer') node.peerHosts.push({ name: requirement.name, specifier: requirement.specifier,
          optional: requirement.optional, host: to.id, path: to.path });
      }
    }
    const reach = (requiredOnly: boolean): Set<string> => {
      const reached = new Set(['']);
      for (const path of reached) {
        visit();
        for (const link of outgoing.get(path)!) {
          visit();
          if (!requiredOnly || !link.requirement.optional) reached.add(link.to.path);
        }
      }
      return reached;
    };
    const reached = reach(false);
    const required = reach(true);
    for (const node of nodes.values()) {
      node.optional = !required.has(node.path);
      if (!reached.has(node.path)) outcome.issues.push({ kind: 'unreachable', path: node.path,
        name: node.name, specifier: null, foundPath: null });
      if (node.declaredOptional !== undefined && node.declaredOptional !== node.optional) outcome.issues.push({
        kind: 'optional-flag-mismatch', path: node.path, name: node.name, specifier: null, foundPath: node.path });
    }
    // Validate the complete virtual tree before any target projection can suppress nodes.
    if (outcome.issues.length) {
      outcome.status = outcome.issues.some(issue => issue.kind.startsWith('missing-')) ? 'incomplete-source-data' : 'invalid-topology';
      return outcome;
    }
    const omitted = new Map<string, NpmOmittedInstance>();
    for (const node of nodes.values()) {
      visit();
      if (omitted.has(node.path) || matches(target.os as string, node.os) && matches(target.cpu as string, node.cpu)) continue;
      if (!node.optional) {
        outcome.issues.push({ kind: 'platform-incompatible', path: node.path, name: node.name,
          specifier: null, foundPath: node.path });
        continue;
      }
      // Find the optional boundary by walking required incoming edges.
      const boundary = new Set([node.path]);
      for (const path of boundary) {
        visit();
        for (const link of incoming.get(path)!) {
          visit();
          if (!link.requirement.optional) boundary.add(link.from.path);
        }
      }
      // Native optionalSet/gatherDepSet: expand then retain only exclusively owned dependencies.
      const region = new Set(boundary);
      const eligible = (link: Link) => !boundary.has(link.to.path) && !omitted.has(link.from.path);
      for (const path of region) {
        visit();
        for (const link of outgoing.get(path)!) { visit(); if (eligible(link)) region.add(link.to.path); }
      }
      let changed = true;
      while (changed && region.size) {
        changed = false;
        for (const path of region) {
          visit();
          for (const link of incoming.get(path)!) {
            visit();
            if (!region.has(link.from.path) && eligible(link)) { region.delete(path); changed = true; break; }
          }
        }
      }
      for (const path of region) if (!omitted.has(path)) omitted.set(path, {
        id: nodes.get(path)!.id, path, reason: 'platform', causePath: node.path });
    }
    if (outcome.issues.length) { outcome.status = 'invalid-topology'; return outcome; }
    outcome.instances = [...nodes.values()].map(({ parent: _parent, requirements: _requirements,
      declaredOptional: _declared, ...instance }) => instance);
    outcome.edges = links.map(link => ({ from: link.from.id, to: link.to.id, ...link.requirement }));
    outcome.activeInstances = outcome.instances.filter(node => !omitted.has(node.path)).map(node => node.id);
    outcome.activeEdges = links.filter(link => !omitted.has(link.from.path) && !omitted.has(link.to.path))
      .map(link => ({ from: link.from.id, to: link.to.id, ...link.requirement }));
    outcome.omittedInstances = paths.flatMap(path => omitted.has(path) ? [omitted.get(path)!] : []);
    outcome.omittedEdges = [...absent, ...links.filter(link => omitted.has(link.from.path) || omitted.has(link.to.path))
      .map(link => ({ from: link.from.id, path: link.from.path, to: link.to.id, foundPath: link.to.path,
        ...link.requirement, reason: 'platform' as const }))];
    return outcome;
  } catch (error) {
    if (!(error instanceof Unsupported) && !(error instanceof Budget)) throw error;
    outcome.status = error instanceof Budget ? 'budget-exhausted' : 'unsupported-semantics';
    if (error instanceof Budget) outcome.budgetReason = error.message;
    else outcome.unsupportedClauses = [error.message];
    outcome.issues = [];
    return outcome;
  }
}
