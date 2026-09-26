import { npmStable } from '../../services/main/src/modules/package/npm-lock.ts';
import type { NpmPlatformOutcome } from '../../services/main/src/modules/package/npm-platform.ts';

export interface NpmNativePlatformTree {
  nodes: Array<{ path: string; name: string; version: string; resolved: string | null; integrity: string | null;
    edges: Array<{ name: string; specifier: string; kind: string; to: string | null; error: string | null }> }>;
  projection: { target: { os: string; cpu: string };
    metadata: Array<{ path: string; optional: boolean; lockedOptional: boolean; os: string | string[] | null; cpu: string | string[] | null }>;
    platformErrors: Array<{ path: string; code: string }>;
    omissions: Array<{ path: string; causePath: string; reason: string }>; activePaths: string[] };
}
export function compareNpmPlatform(key: string, native: NpmNativePlatformTree, result: NpmPlatformOutcome): void {
  const equal = (a: unknown, b: unknown, label: string) => {
    if (npmStable(a) !== npmStable(b)) throw new Error(`${key}: ${label} differs\nnative=${npmStable(a)}\nrezics=${npmStable(b)}`);
  };
  const errors = native.nodes.flatMap(node => node.edges.filter(edge => edge.error).map(edge => ({ path: node.path,
    name: edge.name, specifier: edge.specifier, foundPath: edge.to,
    kind: edge.error === 'MISSING' ? edge.kind.startsWith('peer') ? 'missing-peer' : 'missing-dependency'
      : edge.error === 'PEER LOCAL' ? 'peer-local' : 'version-mismatch' })));
  const status = errors.some(error => error.kind.startsWith('missing-')) ? 'incomplete-source-data'
    : errors.length || native.projection.platformErrors.length ? 'invalid-topology' : 'validated';
  equal(status, result.status, 'status');
  equal(native.projection.target, result.target, 'target');
  const sorted = <T>(items: T[]) => items.map(item => npmStable(item)).sort();
  if (status !== 'validated') {
    const expected = errors.length ? errors : native.projection.platformErrors.map(error => ({ kind: 'platform-incompatible',
      path: error.path, name: native.nodes.find(node => node.path === error.path)!.name,
      specifier: null, foundPath: error.path }));
    equal(sorted(expected), sorted(result.issues), 'failure witnesses');
    for (const field of ['instances', 'edges', 'activeInstances', 'activeEdges', 'omittedInstances', 'omittedEdges'] as const) {
      equal([], result[field], `failed ${field}`);
    }
    return;
  }
  const paths = new Map(result.instances.map(node => [node.id, node.path]));
  const normalizeSelector = (value: string | string[] | null) => typeof value === 'string' ? [value] : value;
  const expectedNodes = native.nodes.map(({ edges: _edges, ...node }) => {
    const metadata = native.projection.metadata.find(item => item.path === node.path)!;
    return { ...node, optional: metadata.optional, os: normalizeSelector(metadata.os), cpu: normalizeSelector(metadata.cpu) };
  });
  equal(sorted(expectedNodes), sorted(result.instances.map(({ id: _id, peerHosts: _peers, ...node }) => node)),
    'locked paths/versions/source/SRI/selectors/optional');
  const normalizedEdges = native.nodes.flatMap(node => node.edges.map(edge => ({ from: node.path,
    to: edge.to, name: edge.name, specifier: edge.specifier,
    optional: edge.kind === 'optional' || edge.kind === 'peerOptional', kind: edge.kind.startsWith('peer') ? 'peer' : 'dependency' })));
  const resultEdges = (edges: NpmPlatformOutcome['edges']) => edges.map(edge => ({ ...edge,
    from: paths.get(edge.from), to: paths.get(edge.to) }));
  equal(sorted(normalizedEdges.filter(edge => edge.to !== null)), sorted(resultEdges(result.edges)), 'locked edges');
  const active = new Set(native.projection.activePaths);
  equal([...active].sort(), result.activeInstances.map(id => paths.get(id)).sort(), 'active paths');
  equal(sorted(normalizedEdges.filter(edge => edge.to !== null && active.has(edge.from) && active.has(edge.to))),
    sorted(resultEdges(result.activeEdges)), 'active edges');
  equal(sorted(native.projection.omissions), sorted(result.omittedInstances.map(({ id, ...item }) => {
    equal(item.path, paths.get(id), 'omitted ID/path'); return item;
  })), 'platform omission witnesses');
  const omittedEdges = normalizedEdges.filter(edge => edge.to === null || !active.has(edge.from) || !active.has(edge.to))
    .map(edge => ({ ...edge, path: edge.from, foundPath: edge.to, reason: edge.to === null ? 'absent-optional' : 'platform' }));
  equal(sorted(omittedEdges), sorted(result.omittedEdges.map(edge => ({ ...edge, from: paths.get(edge.from),
    to: edge.to === null ? null : paths.get(edge.to) }))), 'omitted edges');
  for (const node of result.instances) {
    const peers = normalizedEdges.filter(edge => edge.from === node.path && edge.kind === 'peer' && edge.to !== null)
      .map(edge => ({ name: edge.name, specifier: edge.specifier, optional: edge.optional, path: edge.to }));
    equal(sorted(peers), sorted(node.peerHosts.map(({ host, ...peer }) => {
      equal(peer.path, paths.get(host), 'peer ID/path'); return peer;
    })), 'peer hosts');
  }
}
