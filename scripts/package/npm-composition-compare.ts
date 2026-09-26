import { posix } from 'node:path';
import { npmStable } from '../../services/main/src/modules/package/npm-lock.ts';
import type { NpmCompositionOutcome } from '../../services/main/src/modules/package/npm-composition.ts';
import type { NpmCompositionCase } from '../../tests/qa/fixtures/npm-composition-snapshot.ts';
import type { NpmNativeIdentityTree } from './npm-identity-compare.ts';
import type { NpmNativePlatformTree } from './npm-platform-compare.ts';

export type NpmNativeCompositionTree = NpmNativeIdentityTree & { projection?: NpmNativePlatformTree['projection'] };
export function compareNpmComposition(key: NpmCompositionCase, directory: string, native: NpmNativeCompositionTree,
  result: NpmCompositionOutcome | { status: 'rejected'; message: string }): string | null {
  const equal = (a: unknown, b: unknown, label: string) => {
    if (npmStable(a) !== npmStable(b)) throw new Error(`${key}: ${label} differs\nnative=${npmStable(a)}\nrezics=${npmStable(b)}`);
  };
  const empty = () => {
    if (result.status !== 'rejected') for (const field of [
      'instances', 'edges', 'activeInstances', 'activeEdges', 'omittedInstances', 'omittedEdges'] as const) {
      equal([], result[field], `failed ${field}`);
    }
  };
  const differences: Partial<Record<NpmCompositionCase, [string, string]>> = {
    'alias-identity-mismatch': ['unsupported-semantics', 'Native alias version checks do not authenticate the requested package name.'],
    'plain-identity-mismatch': ['unsupported-semantics', 'Native plain version checks do not authenticate the requested package name.'],
    'missing-source': ['incomplete-source-data', 'Virtual loading does not require artifact source evidence.'],
    'missing-integrity': ['incomplete-source-data', 'Virtual loading does not require SRI evidence.'],
    'malformed-source': ['rejected', 'Malformed source types are rejected before projection or storage.'],
    'malformed-integrity': ['rejected', 'Virtual loading does not validate SRI encoding or artifact bytes.'],
    'missing-workspace-manifest': ['incomplete-source-data', 'Missing workspace bytes do not establish a workspace identity even when native loading retains its lock target.'],
    'missing-workspace-target': ['incomplete-source-data', 'Native loading reports EMISSINGTARGET.'],
    'missing-link-source': ['incomplete-source-data', 'Native loading rejects a link without its source path.'],
    'optional-flag-mismatch': ['invalid-topology', 'The declared optional flag must agree with recomputed native ancestry.'],
    overrides: ['unsupported-semantics', 'Virtual topology cannot qualify override policy.'],
    engines: ['unsupported-semantics', 'Platform projection does not enforce engine policy.'],
  };
  const difference = differences[key];
  if (difference) {
    equal(difference[0], result.status, 'explicit admission boundary');
    if (key === 'missing-workspace-target') equal('EMISSINGTARGET', native.error?.code, 'native loader error');
    else if (key === 'missing-link-source') equal('ERR_INVALID_ARG_TYPE', native.error?.code, 'native loader error');
    else {
      if (!native.nodes || !native.projection || native.error) throw new Error(`${key}: native tree did not load`);
      if (key !== 'malformed-source') equal([], native.nodes.flatMap(node => node.edges.filter(edge => edge.error)), 'native edge acceptance');
      const alias = native.nodes.find(node => node.path === 'node_modules/renamed')!;
      if (key === 'alias-identity-mismatch') equal('different', alias.name, 'recorded alias identity');
      if (key === 'plain-identity-mismatch') equal('actual', alias.name, 'recorded plain identity');
      if (key === 'missing-source') equal(null, alias.resolved, 'missing source');
      if (key === 'missing-integrity') equal(null, alias.integrity, 'missing SRI');
      if (key === 'malformed-integrity') equal('sha512-nope', alias.integrity, 'unvalidated SRI');
      if (key === 'missing-workspace-manifest') equal(false,
        native.nodes[0]!.edges.some(edge => edge.kind === 'workspace'), 'unproven native workspace membership');
      if (key === 'optional-flag-mismatch') {
        const metadata = native.projection.metadata.find(node => node.path === alias.path)!;
        equal([false, true], [metadata.lockedOptional, metadata.optional], 'native flag counterexample');
      }
    }
    empty(); return difference[1];
  }
  if (result.status === 'rejected' || !native.nodes || !native.projection || native.error) {
    throw new Error(`${key}: unexpected native/admission failure`);
  }
  equal('11.19.1', native.npmVersion, 'npm pin'); equal('9.9.1', native.arboristVersion, 'Arborist pin');
  equal(native.projection.target, result.target, 'target');
  const spec = (value: string, kind: string) => kind === 'workspace'
    ? `file:${posix.relative(directory, value.slice(5))}` : value;
  const sorted = (items: unknown[]) => items.map(npmStable).sort();
  const errors = native.nodes.flatMap(node => node.edges.filter(edge => edge.error).map(edge => ({ path: node.path,
    name: edge.name, specifier: spec(edge.specifier, edge.kind), foundPath: edge.to,
    kind: edge.error === 'MISSING' ? edge.kind.startsWith('peer') ? 'missing-peer' : 'missing-dependency'
      : edge.error === 'PEER LOCAL' ? 'peer-local' : edge.kind === 'workspace' ? 'link-target-mismatch' : 'version-mismatch' })));
  const expectedStatus = errors.some(error => error.kind.startsWith('missing-')) ? 'incomplete-source-data'
    : errors.length || native.projection.platformErrors.length ? 'invalid-topology' : 'validated';
  equal(expectedStatus, result.status, 'native topology/platform status');
  if (expectedStatus !== 'validated') {
    const expected = errors.length ? errors : native.projection.platformErrors.map(error => ({ kind: 'platform-incompatible',
      path: error.path, name: native.nodes!.find(node => node.path === error.path)!.name, specifier: null, foundPath: error.path }));
    equal(sorted(expected), sorted(result.issues.filter(issue => issue.kind !== 'unreachable')), 'failure witnesses');
    empty(); return null;
  }
  const paths = new Map(result.instances.map(node => [node.id, node.path]));
  const selector = (value: string | string[] | null) => typeof value === 'string' ? [value] : value;
  equal(sorted(native.nodes.map(node => {
    const metadata = native.projection!.metadata.find(item => item.path === node.path)!;
    if (node.isLink) equal(`file:${posix.relative(posix.dirname(node.path), node.linkTarget!)}`, node.resolved, 'native link source');
    return { path: node.path, name: node.name, version: node.version, slotName: node.slotName,
      kind: node.isLink ? 'link' : node.path === '' ? 'root' : node.isWorkspace ? 'workspace' : 'registry',
      resolved: node.isLink ? node.linkTarget : node.resolved, integrity: node.integrity, linkTarget: node.linkTarget,
      optional: metadata.optional, os: selector(metadata.os), cpu: selector(metadata.cpu) };
  })), sorted(result.instances.map(({ id: _id, peerHosts: _peers, linkTarget, ...node }) => {
    if (linkTarget) equal(linkTarget.path, paths.get(linkTarget.id), 'target ID/path');
    return { ...node, linkTarget: linkTarget?.path ?? null };
  })), 'combined slot/package/source/SRI/link/optional/platform identity');
  const edges = native.nodes.flatMap(node => node.edges.map(edge => ({ from: node.path, to: edge.to,
    name: edge.name, specifier: spec(edge.specifier, edge.kind),
    requestedName: edge.specifier.startsWith('npm:') ? edge.specifier.slice(4, edge.specifier.lastIndexOf('@')) : edge.name,
    kind: edge.kind === 'workspace' ? 'workspace' : edge.kind.startsWith('peer') ? 'peer' : 'dependency',
    optional: edge.kind === 'optional' || edge.kind === 'peerOptional' })));
  const resultEdges = (items: NpmCompositionOutcome['edges']) => items.map(({ from, to, ...edge }) => ({ ...edge,
    from: paths.get(from), to: paths.get(to) }));
  equal(sorted(edges.filter(edge => edge.to !== null)), sorted(resultEdges(result.edges)), 'locked edges');
  const active = new Set(native.projection.activePaths);
  equal([...active].sort(), result.activeInstances.map(id => paths.get(id)).sort(), 'active paths');
  equal(sorted(edges.filter(edge => edge.to !== null && active.has(edge.from) && active.has(edge.to))),
    sorted(resultEdges(result.activeEdges)), 'active edges');
  const omissions = new Map(native.projection.omissions.map(item => [item.path, item]));
  equal(sorted(native.projection.omissions), sorted(result.omittedInstances.map(({ id, ...item }) => {
    equal(item.path, paths.get(id), 'omitted ID/path'); return item;
  })), 'omitted instances and cause paths');
  equal(sorted(edges.filter(edge => edge.to === null || !active.has(edge.from) || !active.has(edge.to)).map(edge => ({
    ...edge, path: edge.from, foundPath: edge.to, reason: edge.to === null ? 'absent-optional' : 'platform',
    causePath: edge.to === null ? null : (omissions.get(edge.from) ?? omissions.get(edge.to))!.causePath,
  }))), sorted(result.omittedEdges.map(({ from, to, ...edge }) => ({ ...edge,
    from: paths.get(from), to: to === null ? null : paths.get(to) }))), 'omitted edges and cause paths');
  for (const node of result.instances) {
    equal(sorted(edges.filter(edge => edge.from === node.path && edge.kind === 'peer' && edge.to !== null)
      .map(edge => [edge.name, edge.specifier, edge.to, edge.optional])), sorted(node.peerHosts.map(peer => {
      equal(peer.path, paths.get(peer.host), 'peer ID/path'); return [peer.name, peer.specifier, peer.path, peer.optional];
    })), 'locked peer hosts');
  }
  return null;
}
