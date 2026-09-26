import { npmSha, npmStable, npmSnapshotSyntax, type NpmBytes, type NpmInstance,
  type NpmIssue, type NpmOutcome } from './npm-lock.ts';

const { object, keys, decode, parseJson, name, version, location, provenance,
  dependencyMap, invalid, Unsupported, Budget, MAX_BYTES } = npmSnapshotSyntax;
export interface NpmWorkspaceInput { path: string; manifest: NpmBytes }
export interface NpmIdentityRequest { profile: 'npm-lock-v3-topology-v3'; npmVersion: string;
  policy: string; manifest: NpmBytes; lock: NpmBytes; workspaces: NpmWorkspaceInput[] }
export interface NpmIdentityInstance extends NpmInstance {
  kind: 'root' | 'registry' | 'workspace' | 'link'; slotName: string | null;
  linkTarget: { id: string; path: string } | null;
}
export interface NpmIdentityEdge { from: string; to: string; kind: 'dependency' | 'peer' | 'workspace';
  name: string; specifier: string; requestedName: string }
export interface NpmIdentityIssue extends Omit<NpmIssue, 'kind'> {
  kind: NpmIssue['kind'] | 'missing-workspace-manifest' | 'missing-workspace-target'
    | 'missing-link-source' | 'link-target-mismatch';
}
export interface NpmIdentityOutcome extends Omit<NpmOutcome, 'instances' | 'edges' | 'issues' | 'cost'> {
  instances: NpmIdentityInstance[]; edges: NpmIdentityEdge[]; issues: NpmIdentityIssue[];
  cost: NpmOutcome['cost'] & { workspaceCount: number; graphVisits: number };
}
interface Requirement extends Omit<NpmIdentityEdge, 'from' | 'to'> {
  exactVersion: string | null; workspacePath: string | null; alias: boolean;
}
interface Node extends NpmIdentityInstance { parent: string | null; requirements: Requirement[] }

function workspacePath(raw: unknown): string {
  if (typeof raw !== 'string' || !raw || raw.length > 512 || raw.includes('\\')
    || raw.startsWith('/') || raw.split('/').some(part => !part || part === '.' || part === '..')) {
    return invalid('malformed npm workspace path');
  }
  const parts = raw.split('/');
  if (parts.length > 8) throw new Budget('npm workspace path depth limit');
  if (parts.some(part => part === 'node_modules' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(part))) {
    throw new Unsupported('only exact safe relative npm workspace paths are admitted');
  }
  return raw;
}
function workspaceDeclarations(raw: unknown): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Unsupported('only a list of exact workspace paths is admitted');
  if (raw.length > 16) throw new Budget('npm workspace count limit');
  const paths = raw.map(workspacePath);
  if (new Set(paths).size !== paths.length) invalid('duplicate npm workspace path');
  for (const path of paths) if (paths.some(other => path !== other && path.startsWith(`${other}/`))) {
    throw new Unsupported('overlapping npm workspace roots');
  }
  return paths;
}
function fields(raw: Record<string, unknown>, kind: 'root' | 'registry' | 'workspace'): void {
  keys(raw, ['name', 'version', 'dependencies', 'peerDependencies', 'license',
    ...(kind === 'registry' ? ['resolved', 'integrity', 'peer'] : ['private']),
    ...(kind === 'root' ? ['workspaces'] : [])]);
  if (raw.license !== undefined && typeof raw.license !== 'string') invalid('malformed license metadata');
  for (const field of ['private', 'peer']) if (raw[field] !== undefined && typeof raw[field] !== 'boolean') {
    invalid(`malformed ${field} metadata`);
  }
}
function agree(manifest: Record<string, unknown>, lock: Record<string, unknown>, root: boolean): void {
  if (manifest.name !== lock.name || manifest.version !== lock.version
    || ['dependencies', 'peerDependencies'].some(field =>
      npmStable(dependencyMap(manifest[field])) !== npmStable(dependencyMap(lock[field])))
    || root && npmStable(manifest.workspaces ?? []) !== npmStable(lock.workspaces ?? [])) {
    invalid('npm manifest and lock package disagree');
  }
}
function requirement(kind: 'dependency' | 'peer', depName: string, raw: unknown): Requirement {
  name(depName);
  if (typeof raw !== 'string') return invalid('malformed npm dependency selector');
  if (raw.startsWith('npm:')) {
    const at = raw.lastIndexOf('@');
    if (at <= 4) throw new Unsupported('only exact named npm aliases are admitted');
    const requestedName = name(raw.slice(4, at));
    return { kind, name: depName, specifier: raw, requestedName, exactVersion: version(raw.slice(at + 1)),
      workspacePath: null, alias: true };
  }
  return { kind, name: depName, specifier: raw, requestedName: depName,
    exactVersion: version(raw), workspacePath: null, alias: false };
}

/** V3 is independent of v1/v2 topology and result shapes; only syntax admission is shared. */
export function validateNpmIdentitySnapshot(request: NpmIdentityRequest): NpmIdentityOutcome {
  const envelope = object(request);
  if (Object.keys(envelope).sort().join(',') !== 'lock,manifest,npmVersion,policy,profile,workspaces'
    || request.profile !== 'npm-lock-v3-topology-v3'
    || typeof request.npmVersion !== 'string' || !request.npmVersion || request.npmVersion.length > 32
    || typeof request.policy !== 'string' || !request.policy || request.policy.length > 64
    || !Array.isArray(request.workspaces) || request.workspaces.length > 16) invalid('malformed npm identity request');
  const manifestText = decode(request.manifest);
  const lockText = decode(request.lock);
  const workspaceTexts = new Map<string, string>();
  for (const item of request.workspaces) {
    const input = object(item);
    if (Object.keys(input).sort().join(',') !== 'manifest,path' || typeof item.path !== 'string'
      || workspaceTexts.has(item.path)) invalid('malformed or duplicate npm workspace input');
    workspaceTexts.set(item.path, decode(item.manifest));
  }
  const texts = [manifestText, lockText, ...workspaceTexts.values()];
  const outcome: NpmIdentityOutcome = { status: 'validated',
    lockId: `urn:rezics:npm-lock:${npmSha(npmStable(request))}`, provenance: 'caller-supplied',
    lockfileVersion: null, instances: [], edges: [], issues: [], unsupportedClauses: [], budgetReason: null,
    cost: { inputBytes: texts.reduce((sum, text) => sum + Buffer.byteLength(text), 0),
      nodeCount: 0, edgeCount: 0, ancestorLookups: 0, workspaceCount: workspaceTexts.size, graphVisits: 0 } };
  const visit = () => { if (++outcome.cost.graphVisits > 65_536) throw new Budget('npm graph visit limit'); };
  const countEdge = () => { if (++outcome.cost.edgeCount > 256) throw new Budget('npm dependency edge limit'); };
  try {
    if (texts.some(text => Buffer.byteLength(text) > MAX_BYTES)) throw new Budget('npm raw file byte limit');
    if (outcome.cost.inputBytes > 262_144) throw new Budget('npm aggregate byte limit');
    const manifest = parseJson(manifestText);
    const lock = parseJson(lockText);
    if (request.npmVersion !== '11.19.1' || request.policy !== 'literal-sources-alias-workspace-v3') {
      throw new Unsupported('unsupported npm version or topology policy');
    }
    fields(manifest, 'root'); name(manifest.name); version(manifest.version);
    const declared = workspaceDeclarations(manifest.workspaces);
    const declaredSet = new Set(declared);
    const workspaces = new Map<string, Record<string, unknown>>();
    const workspaceNames = new Set<string>();
    for (const [path, text] of workspaceTexts) {
      workspacePath(path);
      if (!declaredSet.has(path)) invalid('undeclared npm workspace input');
      const data = parseJson(text);
      fields(data, 'workspace'); name(data.name); version(data.version);
      if (workspaceNames.has(data.name as string)) invalid('duplicate npm workspace package name');
      workspaceNames.add(data.name as string);
      workspaces.set(path, data);
    }
    for (const path of declared) if (!workspaces.has(path)) outcome.issues.push({
      kind: 'missing-workspace-manifest', path, name: '', specifier: null, foundPath: null });
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
    if (lock.name !== manifest.name || lock.version !== manifest.version) invalid('npm manifest and lock root disagree');
    agree(manifest, object(packages['']), true);
    for (const path of declared) if (!Object.hasOwn(packages, path)) outcome.issues.push({
      kind: 'missing-workspace-target', path, name: workspaces.get(path)?.name as string ?? '',
      specifier: null, foundPath: null });
    const slot = (path: string) => {
      if (path.length > 2048) invalid('malformed npm package path');
      if (path.startsWith('node_modules/')) return location(path);
      const start = path.indexOf('/node_modules/');
      if (start === -1 || !declaredSet.has(path.slice(0, start))) {
        throw new Unsupported('package path is outside declared npm workspace roots');
      }
      const prefix = path.slice(0, start);
      const result = location(path.slice(start + 1));
      return { name: result.name, parent: `${prefix}${result.parent ? `/${result.parent}` : ''}` };
    };
    const nodes = new Map<string, Node>();
    const pendingLinks: Array<{ path: string; slotName: string; target: string | null }> = [];
    const identity = (facts: unknown[]) => `urn:rezics:npm-instance:${npmSha(npmStable([outcome.lockId, ...facts]))}`;
    for (const path of paths) {
      const raw = object(packages[path]);
      if (raw.link !== undefined) {
        if (typeof raw.link !== 'boolean') invalid('malformed npm link flag');
        if (raw.link !== true) throw new Unsupported('only true npm workspace links are admitted');
        keys(raw, ['link', 'resolved']);
        const installed = slot(path);
        if (installed.parent !== '') throw new Unsupported('nested npm workspace links');
        let target: string | null = null;
        if (raw.resolved === undefined) outcome.issues.push({ kind: 'missing-link-source',
          path, name: installed.name, specifier: null, foundPath: null });
        else {
          target = workspacePath(raw.resolved);
          if (!declaredSet.has(target)) throw new Unsupported('npm link target is not a declared workspace');
        }
        pendingLinks.push({ path, slotName: installed.name, target });
        continue;
      }
      const kind = path === '' ? 'root' : declaredSet.has(path) ? 'workspace' : 'registry';
      fields(raw, kind);
      const installed = kind === 'registry' ? slot(path) : null;
      const packageName = name(raw.name ?? installed?.name);
      const pkgVersion = version(raw.version);
      if (kind === 'workspace' && workspaces.has(path)) agree(workspaces.get(path)!, raw, false);
      const resolved = kind === 'registry' ? provenance(raw.resolved, 'resolved') : null;
      const integrity = kind === 'registry' ? provenance(raw.integrity, 'integrity') : null;
      if (kind === 'registry' && (!resolved || !integrity)) outcome.issues.push({ kind: 'missing-provenance',
        path, name: packageName, specifier: null, foundPath: null });
      const requirements: Requirement[] = [];
      const names = new Set<string>();
      for (const [field, edgeKind] of [['dependencies', 'dependency'], ['peerDependencies', 'peer']] as const) {
        const deps = dependencyMap(raw[field]);
        for (const depName of Object.keys(deps).sort()) {
          countEdge();
          if (names.has(depName)) throw new Unsupported('overlapping dependency and peer declarations');
          names.add(depName);
          requirements.push(requirement(edgeKind, depName, deps[depName]));
        }
      }
      if (kind === 'root') for (const [path, data] of [...workspaces].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
        countEdge();
        if (names.has(data.name as string)) throw new Unsupported('overlapping root workspace and dependency declarations');
        names.add(data.name as string);
        requirements.push({ kind: 'workspace', name: data.name as string, specifier: `file:${path}`,
          requestedName: data.name as string, exactVersion: null, workspacePath: path, alias: false });
      }
      const slotName = installed?.name ?? null;
      const id = identity([kind, path, slotName, packageName, pkgVersion, resolved, integrity]);
      nodes.set(path, { id, path, kind, slotName, name: packageName, version: pkgVersion, resolved, integrity,
        linkTarget: null, peerHosts: [], parent: kind === 'root' ? null : installed?.parent ?? '', requirements });
    }
    for (const link of pendingLinks) {
      const target = link.target === null ? undefined : nodes.get(link.target);
      if (!target) continue; // Explicit missing source/target issues above; never fabricate an identity.
      const id = identity(['link', link.path, link.slotName, target.name, target.version, link.target, target.id]);
      nodes.set(link.path, { id, path: link.path, kind: 'link', slotName: link.slotName, name: target.name,
        version: target.version, resolved: link.target, integrity: null, linkTarget: { id: target.id, path: target.path },
        peerHosts: [], parent: '', requirements: [] });
    }
    const edges: NpmIdentityEdge[] = [];
    const neighbors = new Map<string, string[]>();
    for (const node of [...nodes.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) {
      const targets = node.linkTarget ? [node.linkTarget.path] : [];
      neighbors.set(node.path, targets);
      if (node.parent !== null && !nodes.has(node.parent)) outcome.issues.push({ kind: 'missing-parent',
        path: node.path, name: node.name, specifier: null, foundPath: node.parent });
      if (node.parent !== null && nodes.get(node.parent)?.kind === 'link') {
        throw new Unsupported('npm link slots cannot own installed children');
      }
      for (const req of node.requirements) {
        let cursor: string | null = node.path;
        let target: Node | undefined;
        while (cursor !== null) {
          if (++outcome.cost.ancestorLookups > 4096) throw new Budget('npm ancestor lookup limit');
          target = nodes.get(`${cursor ? `${cursor}/` : ''}node_modules/${req.name}`);
          if (target) break;
          cursor = nodes.get(cursor)?.parent ?? null;
        }
        const issue = { path: node.path, name: req.name, specifier: req.specifier, foundPath: target?.path ?? null };
        if (!target) outcome.issues.push({ ...issue, kind: req.kind === 'peer' ? 'missing-peer' : 'missing-dependency' });
        else {
          if (req.alias && (target.kind !== 'registry' || req.requestedName !== target.name)) {
            throw new Unsupported('npm alias package identity is not established by the supplied registry node');
          }
          targets.push(target.path);
          if (req.kind === 'peer' && node.kind === 'registry' && target.parent === node.path) {
            outcome.issues.push({ ...issue, kind: 'peer-local' });
          } else if (req.kind === 'workspace'
            ? target.linkTarget?.path !== req.workspacePath : target.version !== req.exactVersion) {
            outcome.issues.push({ ...issue, kind: req.kind === 'workspace' ? 'link-target-mismatch' : 'version-mismatch' });
          }
          edges.push({ from: node.id, to: target.id, kind: req.kind, name: req.name,
            specifier: req.specifier, requestedName: req.requestedName });
          if (req.kind === 'peer') node.peerHosts.push({ name: req.name, specifier: req.specifier,
            host: target.id, path: target.path });
        }
      }
    }
    const reached = new Set<string>();
    const queue = [''];
    for (let at = 0; at < queue.length; at++) {
      visit();
      const path = queue[at]!;
      if (reached.has(path)) continue;
      reached.add(path);
      for (const target of neighbors.get(path) ?? []) { visit(); queue.push(target); }
    }
    for (const node of nodes.values()) if (!reached.has(node.path)) outcome.issues.push({
      kind: 'unreachable', path: node.path, name: node.name, specifier: null, foundPath: null });
    if (outcome.issues.length) {
      outcome.status = outcome.issues.some(issue => issue.kind.startsWith('missing-')) ? 'incomplete-source-data' : 'invalid-topology';
      return outcome;
    }
    outcome.instances = [...nodes.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
      .map(({ parent: _parent, requirements: _requirements, ...instance }) => instance);
    outcome.edges = edges;
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
