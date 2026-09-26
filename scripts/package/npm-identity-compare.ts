import { posix } from 'node:path';
import { npmStable } from '../../services/main/src/modules/package/npm-lock.ts';
import type { NpmIdentityOutcome } from '../../services/main/src/modules/package/npm-identity.ts';
import type { NpmIdentityCase } from '../../tests/qa/fixtures/npm-identity-snapshot.ts';

export interface NpmNativeIdentityTree {
  npmVersion?: string; arboristVersion?: string; error?: { code: string; message: string };
  nodes?: Array<{ path: string; name: string; version: string; slotName: string | null;
    resolved: string | null; integrity: string | null; isLink: boolean; linkTarget: string | null;
    parent: string | null; isWorkspace: boolean;
    edges: Array<{ name: string; specifier: string; kind: string; to: string | null; error: string | null }> }>;
}
export function compareNpmIdentity(key: NpmIdentityCase, directory: string, native: NpmNativeIdentityTree,
  result: NpmIdentityOutcome | { status: 'rejected'; message: string }): string | null {
  const equal = (a: unknown, b: unknown, label: string) => {
    if (npmStable(a) !== npmStable(b)) throw new Error(`${key}: ${label} differs\nnative=${npmStable(a)}\nrezics=${npmStable(b)}`);
  };
  const differences: Partial<Record<NpmIdentityCase, [string, string]>> = {
    'alias-identity-mismatch': ['unsupported-semantics', 'Virtual alias edges check version, not package-name authenticity.'],
    'missing-link-source': ['incomplete-source-data', 'Native loader rejects a link with no target path.'],
    'missing-workspace-target': ['incomplete-source-data', 'Native loader reports EMISSINGTARGET.'],
    'malformed-link': ['rejected', 'Native accepts truthy link metadata; the profile requires boolean true.'],
    'missing-source': ['incomplete-source-data', 'Virtual trees do not require artifact source evidence.'],
    'missing-integrity': ['incomplete-source-data', 'Virtual trees do not require SRI evidence.'],
    'malformed-source': ['rejected', 'Malformed literal source types are rejected before receipt creation.'],
    'malformed-integrity': ['rejected', 'Virtual trees do not validate SRI encoding or artifact bytes.'],
    'unknown-source': ['unsupported-semantics', 'Git sources are outside the literal HTTPS registry profile.'],
    overrides: ['unsupported-semantics', 'Override policy is not qualified by virtual-tree acceptance.'],
    engines: ['unsupported-semantics', 'Engine policy is not enforced by loadVirtual.'],
  };
  const difference = differences[key];
  if (difference) {
    equal(difference[0], result.status, 'explicit admission boundary');
    if (key === 'missing-workspace-target') equal('EMISSINGTARGET', native.error?.code, 'native loader error');
    else if (key === 'missing-link-source') equal('ERR_INVALID_ARG_TYPE', native.error?.code, 'native loader error');
    else {
      if (!native.nodes || native.error) throw new Error(`${key}: native tree did not load`);
      if (key !== 'malformed-source') equal([], native.nodes.flatMap(node => node.edges.filter(edge => edge.error)), 'native acceptance');
      const alias = native.nodes.find(node => node.path === 'node_modules/renamed')!;
      if (key === 'alias-identity-mismatch') equal('different', alias.name, 'recorded package identity');
      if (key === 'missing-source') equal(null, alias.resolved, 'absent native source');
      if (key === 'missing-integrity') equal(null, alias.integrity, 'absent native SRI');
      if (key === 'malformed-integrity') equal('sha512-nope', alias.integrity, 'unvalidated native SRI');
    }
    if (result.status !== 'rejected') { equal([], result.instances, 'failure instances'); equal([], result.edges, 'failure edges'); }
    return difference[1];
  }
  if (result.status === 'rejected' || !native.nodes || native.error) throw new Error(`${key}: unexpected loader/admission error`);
  equal('11.19.1', native.npmVersion, 'npm version');
  const spec = (value: string, kind: string) => kind === 'workspace'
    ? `file:${posix.relative(directory, value.slice(5))}` : value;
  const errors = native.nodes.flatMap(node => node.edges.filter(edge => edge.error).map(edge => ({ path: node.path,
    name: edge.name, specifier: spec(edge.specifier, edge.kind), foundPath: edge.to,
    kind: edge.error === 'MISSING' ? edge.kind === 'peer' ? 'missing-peer' : 'missing-dependency'
      : edge.error === 'PEER LOCAL' ? 'peer-local' : edge.kind === 'workspace' ? 'link-target-mismatch' : 'version-mismatch' })));
  const status = errors.some(error => error.kind.startsWith('missing-')) ? 'incomplete-source-data'
    : errors.length ? 'invalid-topology' : 'validated';
  equal(status, result.status, 'native topology outcome');
  const sorted = (items: unknown[]) => items.map(item => npmStable(item)).sort();
  if (status !== 'validated') {
    equal(sorted(errors), sorted(result.issues.filter(issue => issue.kind !== 'unreachable')), 'rejected edges and hosts');
    equal([], result.instances, 'failure instances'); equal([], result.edges, 'failure edges');
    return null;
  }
  const nodes = new Map(result.instances.map(node => [node.id, node]));
  equal(sorted(native.nodes.map(node => {
    if (node.isLink) equal(`file:${posix.relative(posix.dirname(node.path), node.linkTarget!)}`, node.resolved, 'native link source');
    return { path: node.path, name: node.name, slotName: node.slotName, version: node.version,
      kind: node.isLink ? 'link' : node.path === '' ? 'root' : node.isWorkspace ? 'workspace' : 'registry',
      resolved: node.isLink ? node.linkTarget : node.resolved, integrity: node.integrity, linkTarget: node.linkTarget };
  })), sorted(result.instances.map(({ id: _id, peerHosts: _hosts, linkTarget, ...node }) => {
    if (linkTarget) equal(linkTarget.path, nodes.get(linkTarget.id)?.path, 'link target ID/path');
    return { ...node, linkTarget: linkTarget?.path ?? null };
  })), 'path/slot/package/source/SRI/link identity');
  equal(sorted(native.nodes.flatMap(node => node.edges.map(edge => ({ from: node.path, to: edge.to,
    kind: edge.kind === 'prod' ? 'dependency' : edge.kind, name: edge.name, specifier: spec(edge.specifier, edge.kind),
    requestedName: edge.specifier.startsWith('npm:') ? edge.specifier.slice(4, edge.specifier.lastIndexOf('@')) : edge.name })))),
  sorted(result.edges.map(({ from, to, ...edge }) => ({ ...edge, from: nodes.get(from)?.path, to: nodes.get(to)?.path }))), 'declared/native edges');
  for (const node of result.instances) {
    equal(sorted(native.nodes.find(item => item.path === node.path)!.edges.filter(edge => edge.kind === 'peer')
      .map(edge => [edge.name, edge.specifier, edge.to])), sorted(node.peerHosts.map(host => {
      equal(host.path, nodes.get(host.host)?.path, 'peer host ID/path');
      return [host.name, host.specifier, host.path];
    })), 'exact peer hosts');
  }
  return null;
}
