import { npmSha, npmStable, npmSnapshotSyntax, type NpmBytes, type NpmInstance,
  type NpmIssue, type NpmOutcome, type NpmPeerHost } from './npm-lock.ts';
import { projectNpmComposition, npmPlatformSelector as selector } from './npm-composition-project.ts';

const { object, keys, decode, parseJson, name, version, location, provenance,
  dependencyMap, invalid, Unsupported, Budget, MAX_BYTES } = npmSnapshotSyntax;
export interface NpmWorkspaceInput { path: string; manifest: NpmBytes }
export interface NpmCompositionRequest { profile: 'npm-lock-v3-topology-v4'; npmVersion: string;
  policy: string; manifest: NpmBytes; lock: NpmBytes; workspaces: NpmWorkspaceInput[]; target: { os: string; cpu: string } }
export interface NpmPolicyRequest extends Omit<NpmCompositionRequest, 'profile'> {
  profile: 'npm-lock-v3-topology-v5'; engineTarget: { nodeVersion: string; npmVersion: string } }
export interface NpmPolicyOutcome extends NpmCompositionOutcome {
  engineTarget: NpmPolicyRequest['engineTarget'];
  overrideSelections: Array<{ fromPath: string; toPath: string | null; name: string;
    declaredSpecifier: string; effectiveSpecifier: string }>;
  engineChecks: Array<{ path: string; node: string | null; npm: string | null; compatible: boolean }>;
}
export interface NpmCompositionInstance extends Omit<NpmInstance, 'peerHosts'> {
  peerHosts: Array<NpmPeerHost & { optional: boolean }>; optional: boolean;
  os: string[] | null; cpu: string[] | null;
  kind: 'root' | 'registry' | 'workspace' | 'link'; slotName: string | null;
  linkTarget: { id: string; path: string } | null;
}
export interface NpmCompositionEdge { from: string; to: string; kind: 'dependency' | 'peer' | 'workspace';
  name: string; specifier: string; requestedName: string; optional: boolean }
export interface NpmCompositionIssue extends Omit<NpmIssue, 'kind'> {
  kind: NpmIssue['kind'] | 'missing-workspace-manifest' | 'missing-workspace-target'
    | 'missing-link-source' | 'link-target-mismatch' | 'optional-flag-mismatch' | 'platform-incompatible'
    | 'engine-incompatible';
}
export interface NpmCompositionOutcome extends Omit<NpmOutcome, 'instances' | 'edges' | 'issues' | 'cost'> {
  instances: NpmCompositionInstance[]; edges: NpmCompositionEdge[]; issues: NpmCompositionIssue[];
  target: { os: string; cpu: string }; activeInstances: string[]; activeEdges: NpmCompositionEdge[];
  omittedInstances: Array<{ id: string; path: string; reason: 'platform'; causePath: string }>;
  omittedEdges: Array<Omit<NpmCompositionEdge, 'to'> & { to: string | null; path: string;
    foundPath: string | null; reason: 'platform' | 'absent-optional'; causePath: string | null }>;
  cost: NpmOutcome['cost'] & { workspaceCount: number; graphVisits: number };
}
interface Requirement extends Omit<NpmCompositionEdge, 'from' | 'to'> {
  exactVersion: string | null; workspacePath: string | null; alias: boolean;
  effectiveSpecifier?: string;
}
export interface NpmCompositionNode extends NpmCompositionInstance { parent: string | null; requirements: Requirement[];
  declaredOptional: boolean | undefined }
type Node = NpmCompositionNode;
export interface NpmCompositionLink { from: Node; to: Node; requirement: Requirement }

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
function fields(raw: Record<string, unknown>, kind: 'root' | 'registry' | 'workspace', policy = false): void {
  keys(raw, ['name', 'version', 'dependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta', 'os', 'cpu', 'license',
    ...(policy ? ['engines'] : []),
    ...(kind === 'root' ? [] : ['optional']),
    ...(kind === 'registry' ? ['resolved', 'integrity', 'peer'] : ['private']),
    ...(kind === 'root' ? ['workspaces', ...(policy ? ['overrides'] : [])] : [])]);
  if (raw.license !== undefined && typeof raw.license !== 'string') invalid('malformed license metadata');
  for (const field of ['private', 'peer', 'optional']) if (raw[field] !== undefined && typeof raw[field] !== 'boolean') {
    invalid(`malformed ${field} metadata`);
  }
}
function agree(manifest: Record<string, unknown>, lock: Record<string, unknown>, root: boolean, policy = false): void {
  if (manifest.name !== lock.name || manifest.version !== lock.version
    || ['dependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta'].some(field =>
      npmStable(dependencyMap(manifest[field])) !== npmStable(dependencyMap(lock[field])))
    || ['os', 'cpu'].some(field => npmStable(manifest[field] ?? null) !== npmStable(lock[field] ?? null))
    || root && npmStable(manifest.workspaces ?? []) !== npmStable(lock.workspaces ?? [])
    || policy && !root && npmStable(manifest.engines ?? null) !== npmStable(lock.engines ?? null)) {
    invalid('npm manifest and lock package disagree');
  }
}

function engineVersion(raw: unknown): [number, number, number] {
  if (typeof raw !== 'string') return invalid('malformed npm engine version');
  if (!/^\d{1,8}\.\d{1,8}\.\d{1,8}$/.test(raw)) throw new Unsupported('only exact stable npm engine target versions are admitted');
  return raw.split('.').map(Number) as [number, number, number];
}
function engineRange(raw: unknown): { raw: string; minimum: boolean; value: [number, number, number] } {
  if (typeof raw !== 'string') return invalid('malformed npm engine requirement');
  const minimum = raw.startsWith('>=');
  const value = engineVersion(minimum ? raw.slice(2) : raw);
  return { raw, minimum, value };
}
function engineMetadata(raw: unknown): { node: string | null; npm: string | null;
  ranges: Array<{ key: 'node' | 'npm'; minimum: boolean; value: [number, number, number] }> } {
  if (raw === undefined) return { node: null, npm: null, ranges: [] };
  const data = object(raw); keys(data, ['node', 'npm']);
  const ranges: Array<{ key: 'node' | 'npm'; minimum: boolean; value: [number, number, number] }> = [];
  for (const key of ['node', 'npm'] as const) if (data[key] !== undefined) ranges.push({ key, ...engineRange(data[key]) });
  return { node: data.node as string ?? null, npm: data.npm as string ?? null, ranges };
}
function engineMatches(target: [number, number, number], range: { minimum: boolean; value: [number, number, number] }): boolean {
  const comparison = target[0] - range.value[0] || target[1] - range.value[1] || target[2] - range.value[2];
  return range.minimum ? comparison >= 0 : comparison === 0;
}
function rootOverrides(raw: unknown): Map<string, string> {
  if (raw === undefined) return new Map();
  const map = object(raw);
  const entries = Object.entries(map).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  if (entries.length > 32) throw new Budget('npm root override rule limit');
  const result = new Map<string, string>();
  for (const [key, value] of entries) {
    name(key);
    if (typeof value !== 'string') {
      if (value !== null && typeof value === 'object') throw new Unsupported('nested npm overrides are outside this profile');
      return invalid('malformed npm root override value');
    }
    result.set(key, version(value));
  }
  return result;
}
function requirement(kind: 'dependency' | 'peer', depName: string, raw: unknown, optional: boolean): Requirement {
  name(depName);
  if (typeof raw !== 'string') return invalid('malformed npm dependency selector');
  if (raw.startsWith('npm:')) {
    const at = raw.lastIndexOf('@');
    if (at <= 4) throw new Unsupported('only exact named npm aliases are admitted');
    const requestedName = name(raw.slice(4, at));
    return { kind, optional, name: depName, specifier: raw, requestedName, exactVersion: version(raw.slice(at + 1)),
      workspacePath: null, alias: true };
  }
  return { kind, optional, name: depName, specifier: raw, requestedName: depName,
    exactVersion: version(raw), workspacePath: null, alias: false };
}

/** V4 owns composition. Historical v1/v2/v3 validators and receipt bytes stay frozen. */
export function validateNpmCompositionSnapshot(request: NpmCompositionRequest): NpmCompositionOutcome {
  return validateComposition(request);
}
export function validateNpmPolicySnapshot(request: NpmPolicyRequest): NpmPolicyOutcome {
  return validateComposition(request) as NpmPolicyOutcome;
}
function validateComposition(request: NpmCompositionRequest | NpmPolicyRequest): NpmCompositionOutcome {
  const policy = request.profile === 'npm-lock-v3-topology-v5';
  const envelope = object(request);
  if (Object.keys(envelope).sort().join(',') !== (policy
    ? 'engineTarget,lock,manifest,npmVersion,policy,profile,target,workspaces'
    : 'lock,manifest,npmVersion,policy,profile,target,workspaces')
    || typeof request.npmVersion !== 'string' || !request.npmVersion || request.npmVersion.length > 32
    || typeof request.policy !== 'string' || !request.policy || request.policy.length > 64
    || !Array.isArray(request.workspaces) || request.workspaces.length > 16) invalid('malformed npm composition request');
  const target = object(request.target);
  if (Object.keys(target).sort().join(',') !== 'cpu,os'
    || [target.os, target.cpu].some(value => typeof value !== 'string' || !value || value.length > 32)) {
    invalid('malformed npm target');
  }
  if (policy) {
    const engine = object(request.engineTarget);
    if (Object.keys(engine).sort().join(',') !== 'nodeVersion,npmVersion'
      || Object.values(engine).some(value => typeof value !== 'string' || !value || value.length > 32)) {
      invalid('malformed npm engine target');
    }
  }
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
  const outcome: NpmCompositionOutcome = { status: 'validated', target: { ...request.target },
    activeInstances: [], activeEdges: [], omittedInstances: [], omittedEdges: [],
    lockId: `urn:rezics:npm-lock:${npmSha(npmStable(request))}`, provenance: 'caller-supplied',
    lockfileVersion: null, instances: [], edges: [], issues: [], unsupportedClauses: [], budgetReason: null,
    cost: { inputBytes: texts.reduce((sum, text) => sum + Buffer.byteLength(text), 0),
      nodeCount: 0, edgeCount: 0, ancestorLookups: 0, workspaceCount: workspaceTexts.size, graphVisits: 0 } };
  if (policy) Object.assign(outcome, { engineTarget: { ...request.engineTarget },
    overrideSelections: [], engineChecks: [] });
  const visit = () => { if (++outcome.cost.graphVisits > 65_536) throw new Budget('npm graph visit limit'); };
  const countEdge = () => { if (++outcome.cost.edgeCount > 256) throw new Budget('npm dependency edge limit'); };
  try {
    if (texts.some(text => Buffer.byteLength(text) > MAX_BYTES)) throw new Budget('npm raw file byte limit');
    if (outcome.cost.inputBytes > 262_144) throw new Budget('npm aggregate byte limit');
    const manifest = parseJson(manifestText);
    const lock = parseJson(lockText);
    if (request.npmVersion !== '11.19.1' || request.policy !== (policy
      ? 'literal-sources-policy-v5' : 'literal-sources-composed-v4')) {
      throw new Unsupported('unsupported npm version or topology policy');
    }
    if (!['linux', 'win32'].includes(request.target.os) || !['x64', 'arm64'].includes(request.target.cpu)) {
      throw new Unsupported('unsupported npm target environment');
    }
    fields(manifest, 'root', policy); name(manifest.name); version(manifest.version);
    const overrides = policy ? rootOverrides(manifest.overrides) : new Map<string, string>();
    const engineTarget = policy ? { node: engineVersion(request.engineTarget.nodeVersion),
      npm: engineVersion(request.engineTarget.npmVersion) } : null;
    const declared = workspaceDeclarations(manifest.workspaces);
    const declaredSet = new Set(declared);
    const workspaces = new Map<string, Record<string, unknown>>();
    const workspaceNames = new Set<string>();
    for (const [path, text] of workspaceTexts) {
      workspacePath(path);
      if (!declaredSet.has(path)) invalid('undeclared npm workspace input');
      const data = parseJson(text);
      fields(data, 'workspace', policy); name(data.name); version(data.version);
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
    agree(manifest, object(packages['']), true, policy);
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
      fields(raw, kind, policy);
      const installed = kind === 'registry' ? slot(path) : null;
      const packageName = name(raw.name ?? installed?.name);
      const pkgVersion = version(raw.version);
      if (kind === 'workspace' && workspaces.has(path)) agree(workspaces.get(path)!, raw, false, policy);
      if (policy) {
        const engine = engineMetadata(kind === 'root' ? manifest.engines : raw.engines);
        const compatible = engine.ranges.every(range => engineMatches(engineTarget![range.key], range));
        (outcome as NpmPolicyOutcome).engineChecks.push({ path, node: engine.node, npm: engine.npm, compatible });
        if (!compatible) outcome.issues.push({ kind: 'engine-incompatible', path,
          name: packageName, specifier: null, foundPath: path });
      }
      const resolved = kind === 'registry' ? provenance(raw.resolved, 'resolved') : null;
      const integrity = kind === 'registry' ? provenance(raw.integrity, 'integrity') : null;
      if (kind === 'registry' && (!resolved || !integrity)) outcome.issues.push({ kind: 'missing-provenance',
        path, name: packageName, specifier: null, foundPath: null });
      const peers = dependencyMap(raw.peerDependencies);
      const meta = dependencyMap(raw.peerDependenciesMeta);
      for (const peer of Object.keys(meta)) {
        name(peer);
        if (!Object.hasOwn(peers, peer)) invalid('npm optional peer metadata has no declared peer');
        const value = object(meta[peer]); keys(value, ['optional']);
        if (value.optional !== undefined && typeof value.optional !== 'boolean') invalid('malformed optional peer metadata');
      }
      const requirements: Requirement[] = [];
      const names = new Set<string>();
      for (const [field, edgeKind] of [['dependencies', 'dependency'], ['optionalDependencies', 'dependency'], ['peerDependencies', 'peer']] as const) {
        const deps = dependencyMap(raw[field]);
        for (const depName of Object.keys(deps).sort()) {
          countEdge();
          if (names.has(depName)) throw new Unsupported('overlapping dependency and peer declarations');
          names.add(depName);
          const optional = field === 'optionalDependencies'
            || edgeKind === 'peer' && Object.hasOwn(meta, depName) && object(meta[depName]).optional === true;
          const req = requirement(edgeKind, depName, deps[depName], optional);
          const replacement = policy ? overrides.get(depName) : undefined;
          if (replacement !== undefined) {
            if (edgeKind !== 'dependency' || req.alias) {
              throw new Unsupported('peer and alias override selection is outside this profile');
            }
            if (kind === 'root' && req.specifier !== replacement) {
              throw new Unsupported('native EOVERRIDE: direct root dependency conflicts with override');
            }
            req.exactVersion = replacement;
            req.effectiveSpecifier = replacement;
          }
          requirements.push(req);
        }
      }
      if (kind === 'root') for (const [path, data] of [...workspaces].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
        countEdge();
        if (names.has(data.name as string)) throw new Unsupported('overlapping root workspace and dependency declarations');
        names.add(data.name as string);
        requirements.push({ kind: 'workspace', optional: false, name: data.name as string, specifier: `file:${path}`,
          requestedName: data.name as string, exactVersion: null, workspacePath: path, alias: false });
      }
      const slotName = installed?.name ?? null;
      const id = identity([kind, path, slotName, packageName, pkgVersion, resolved, integrity]);
      nodes.set(path, { id, path, kind, slotName, name: packageName, version: pkgVersion, resolved, integrity,
        optional: true, declaredOptional: raw.optional as boolean | undefined, os: selector(raw.os, 'os'), cpu: selector(raw.cpu, 'cpu'),
        linkTarget: null, peerHosts: [], parent: kind === 'root' ? null : installed?.parent ?? '', requirements });
    }
    for (const link of pendingLinks) {
      const target = link.target === null ? undefined : nodes.get(link.target);
      if (!target) continue; // Explicit missing source/target issues above; never fabricate an identity.
      const id = identity(['link', link.path, link.slotName, target.name, target.version, link.target, target.id]);
      nodes.set(link.path, { id, path: link.path, kind: 'link', slotName: link.slotName, name: target.name,
        version: target.version, resolved: link.target, integrity: null, linkTarget: { id: target.id, path: target.path },
        optional: true, declaredOptional: undefined, os: target.os, cpu: target.cpu,
        peerHosts: [], parent: '', requirements: [] });
    }
    const links: NpmCompositionLink[] = [];
    const absent: NpmCompositionOutcome['omittedEdges'] = [];
    const ordered = [...nodes.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    for (const node of ordered) {
      if (node.parent !== null && !nodes.has(node.parent)) outcome.issues.push({ kind: 'missing-parent',
        path: node.path, name: node.name, specifier: null, foundPath: node.parent });
      if (node.parent !== null && nodes.get(node.parent)?.kind === 'link') {
        throw new Unsupported('npm link slots cannot own installed children');
      }
      for (const req of node.requirements) {
        let cursor: string | null = node.path;
        let to: Node | undefined;
        while (cursor !== null) {
          if (++outcome.cost.ancestorLookups > 4096) throw new Budget('npm ancestor lookup limit');
          to = nodes.get(`${cursor ? `${cursor}/` : ''}node_modules/${req.name}`);
          if (to) break;
          cursor = nodes.get(cursor)?.parent ?? null;
        }
        const issue = { path: node.path, name: req.name, specifier: req.specifier, foundPath: to?.path ?? null };
        if (!to) {
          if (req.optional) absent.push({ from: node.id, to: null, kind: req.kind, optional: true,
            name: req.name, specifier: req.specifier, requestedName: req.requestedName,
            path: node.path, foundPath: null, reason: 'absent-optional', causePath: null });
          else outcome.issues.push({ ...issue, kind: req.kind === 'peer' ? 'missing-peer' : 'missing-dependency' });
          continue;
        }
        if (policy && req.effectiveSpecifier !== undefined) {
          if (to.kind !== 'registry') throw new Unsupported('workspace override selection is outside this profile');
          (outcome as NpmPolicyOutcome).overrideSelections.push({ fromPath: node.path, toPath: to.path,
            name: req.name, declaredSpecifier: req.specifier, effectiveSpecifier: req.effectiveSpecifier });
        }
        // Native version/alias edges do not authenticate names. Refuse unproven identities,
        // including inside a branch that would disappear on this target.
        if (req.kind !== 'workspace' && (req.requestedName !== to.name || req.alias && to.kind !== 'registry')) {
          throw new Unsupported('npm requested package identity is not established by the supplied node');
        }
        if (req.kind === 'peer' && node.kind === 'registry' && to.parent === node.path) {
          outcome.issues.push({ ...issue, kind: 'peer-local' });
        } else if (req.kind === 'workspace'
          ? to.linkTarget?.path !== req.workspacePath || to.name !== req.requestedName : to.version !== req.exactVersion) {
          outcome.issues.push({ ...issue, kind: req.kind === 'workspace' ? 'link-target-mismatch' : 'version-mismatch' });
        }
        links.push({ from: node, to, requirement: req });
        if (req.kind === 'peer') node.peerHosts.push({ name: req.name, specifier: req.specifier,
          host: to.id, path: to.path, optional: req.optional });
      }
    }
    projectNpmComposition(outcome, ordered, links, absent, visit);
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
