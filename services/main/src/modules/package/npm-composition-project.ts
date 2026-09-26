import { npmSnapshotSyntax } from './npm-lock.ts';
import type { NpmCompositionEdge, NpmCompositionLink as Link, NpmCompositionNode as Node,
  NpmCompositionOutcome } from './npm-composition.ts';

const { invalid, Unsupported, Budget } = npmSnapshotSyntax;
export function npmPlatformSelector(raw: unknown, field: 'os' | 'cpu'): string[] | null {
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
function edge(link: Link): NpmCompositionEdge {
  const { kind, name, specifier, requestedName, optional } = link.requirement;
  return { from: link.from.id, to: link.to.id, kind, name, specifier, requestedName, optional };
}

/** Link targets participate in flags/reachability, but are not native dependency edges. */
export function projectNpmComposition(outcome: NpmCompositionOutcome, ordered: Node[], links: Link[],
  absent: NpmCompositionOutcome['omittedEdges'], visit: () => void): void {
  const nodes = new Map(ordered.map(node => [node.path, node]));
  const outgoing = new Map(ordered.map(node => [node.path, [] as Link[]]));
  const incoming = new Map(ordered.map(node => [node.path, [] as Link[]]));
  for (const link of links) {
    visit(); outgoing.get(link.from.path)!.push(link); incoming.get(link.to.path)!.push(link);
  }
  const reach = (requiredOnly: boolean): Set<string> => {
    const reached = new Set(['']);
    for (const path of reached) {
      visit();
      const node = nodes.get(path)!;
      if (node.linkTarget) { visit(); reached.add(node.linkTarget.path); }
      for (const link of outgoing.get(path)!) {
        visit();
        if (!requiredOnly || !link.requirement.optional) reached.add(link.to.path);
      }
    }
    return reached;
  };
  const reached = reach(false);
  const required = reach(true);
  for (const node of ordered) {
    visit();
    node.optional = !required.has(node.path);
    if (!reached.has(node.path)) outcome.issues.push({ kind: 'unreachable', path: node.path,
      name: node.name, specifier: null, foundPath: null });
    if (node.declaredOptional !== undefined && node.declaredOptional !== node.optional) outcome.issues.push({
      kind: 'optional-flag-mismatch', path: node.path, name: node.name, specifier: null, foundPath: node.path });
  }
  // Never hide incomplete/invalid source topology behind a platform omission.
  if (outcome.issues.length) {
    outcome.status = outcome.issues.some(issue => issue.kind.startsWith('missing-')) ? 'incomplete-source-data' : 'invalid-topology';
    return;
  }
  const omitted = new Map<string, NpmCompositionOutcome['omittedInstances'][number]>();
  for (const node of ordered) {
    visit();
    if (omitted.has(node.path) || matches(outcome.target.os, node.os) && matches(outcome.target.cpu, node.cpu)) continue;
    if (!node.optional) {
      outcome.issues.push({ kind: 'platform-incompatible', path: node.path, name: node.name,
        specifier: null, foundPath: node.path });
      continue;
    }
    const boundary = new Set([node.path]);
    for (const path of boundary) {
      visit();
      for (const link of incoming.get(path)!) {
        visit();
        if (!link.requirement.optional) boundary.add(link.from.path);
      }
    }
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
    for (const path of region) {
      visit();
      if (!omitted.has(path)) omitted.set(path, { id: nodes.get(path)!.id, path, reason: 'platform', causePath: node.path });
    }
  }
  if (outcome.issues.length) { outcome.status = 'invalid-topology'; return; }
  // Publish all arrays only after the entire bounded projection succeeds.
  const instances: NpmCompositionOutcome['instances'] = [];
  const activeInstances: string[] = [];
  const omittedInstances: NpmCompositionOutcome['omittedInstances'] = [];
  const edges: NpmCompositionEdge[] = [];
  const activeEdges: NpmCompositionEdge[] = [];
  const omittedEdges = [...absent];
  for (const { parent: _parent, requirements: _reqs, declaredOptional: _declared, ...node } of ordered) {
    visit(); instances.push(node);
    if (omitted.has(node.path)) omittedInstances.push(omitted.get(node.path)!);
    else activeInstances.push(node.id);
  }
  for (const link of links) {
    visit();
    const item = edge(link); edges.push(item);
    const cause = omitted.get(link.from.path) ?? omitted.get(link.to.path);
    if (cause) omittedEdges.push({ ...item, path: link.from.path, foundPath: link.to.path,
      reason: 'platform', causePath: cause.causePath });
    else activeEdges.push(item);
  }
  Object.assign(outcome, { instances, edges, activeInstances, activeEdges, omittedInstances, omittedEdges });
}
