export type SearchResourceScope = Readonly<{ kind: 'realm' | 'collection'; id: string }>;

export type ResourceScopeParse = {
  scope?: SearchResourceScope;
  invalidInput?: { key: 'filter'; value: string };
};

type ResourceLeaf = { kind: string; leaf: Record<string, unknown>; operand: unknown };

const resourceKinds = ['realm', 'collection', 'zone', 'agent', 'library'] as const;
const nativeId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const idPattern = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function invalid(filter: string): ResourceScopeParse {
  return { invalidInput: { key: 'filter', value: filter } };
}

function findResourceLeaves(value: unknown, leaves: ResourceLeaf[] = []): ResourceLeaf[] {
  if (Array.isArray(value)) {
    for (const entry of value) findResourceLeaves(entry, leaves);
    return leaves;
  }
  if (!isRecord(value)) return leaves;

  for (const kind of resourceKinds) {
    if (Object.hasOwn(value, kind)) leaves.push({ kind, leaf: value, operand: value[kind] });
  }
  for (const [key, child] of Object.entries(value)) {
    if (!(resourceKinds as readonly string[]).includes(key)) findResourceLeaves(child, leaves);
  }
  return leaves;
}

function isTopLevelConjunct(root: unknown, leaf: Record<string, unknown>): boolean {
  if (root === leaf) return true;
  return isRecord(root) && Array.isArray(root.and) && Object.keys(root).length === 1 && root.and.includes(leaf);
}

/** Read the request-only native resource leaf from the existing filter grammar. Labels never enter this predicate. */
export function parseSearchResourceScope(filter?: string): ResourceScopeParse {
  if (filter === undefined || filter === '') return {};
  let document: unknown;
  try {
    document = JSON.parse(filter);
  } catch {
    return invalid(filter);
  }

  const leaves = findResourceLeaves(document);
  if (!leaves.length) return {};
  if (leaves.length !== 1) return invalid(filter);
  const candidate = leaves[0]!;
  if (
    !isTopLevelConjunct(document, candidate.leaf) ||
    !hasOnlyKeys(candidate.leaf, [candidate.kind]) ||
    (candidate.kind !== 'realm' && candidate.kind !== 'collection')
  )
    return invalid(filter);
  if (
    !isRecord(candidate.operand) ||
    !hasOnlyKeys(candidate.operand, ['id']) ||
    typeof candidate.operand.id !== 'string' ||
    !nativeId.test(candidate.operand.id)
  )
    return invalid(filter);

  return { scope: { kind: candidate.kind, id: candidate.operand.id.toLowerCase() } };
}

export function isSearchResourceScope(value: unknown): value is SearchResourceScope {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['kind', 'id']) &&
    (value.kind === 'realm' || value.kind === 'collection') &&
    typeof value.id === 'string' &&
    nativeId.test(value.id)
  );
}

export function searchResourceScopeClause(scope: SearchResourceScope): Record<string, { id: string }> {
  if (!isSearchResourceScope(scope)) throw new Error('Invalid search resource scope');
  return { [scope.kind]: { id: scope.id.toLowerCase() } };
}

/** Remove only a top-level native scope leaf, retaining the other authored filter clauses. */
export function removeSearchResourceScope(filter?: string): string | undefined {
  if (filter === undefined || filter === '') return undefined;
  let document: unknown;
  try {
    document = JSON.parse(filter);
  } catch {
    return undefined;
  }
  const parsed = parseSearchResourceScope(filter);
  if (parsed.invalidInput) return undefined;
  if (!parsed.scope) return filter;

  const leaves = findResourceLeaves(document);
  const scopeLeaf = leaves[0]?.leaf;
  if (!scopeLeaf) return filter;
  if (document === scopeLeaf) return undefined;
  if (!isRecord(document) || !Array.isArray(document.and)) return undefined;
  const remaining = document.and.filter((entry) => entry !== scopeLeaf);
  if (!remaining.length) return undefined;
  return JSON.stringify(remaining.length === 1 ? remaining[0] : { and: remaining });
}

/** Place a scope leaf in the native filter tree, preserving any other predicate as a sibling. */
export function searchFilterWithScope(filter: string | undefined, scope?: SearchResourceScope): string | undefined {
  if (!scope) return filter;
  if (!isSearchResourceScope(scope)) throw new Error('Invalid search resource scope');
  const existing = parseSearchResourceScope(filter);
  if (existing.invalidInput) throw new Error('Invalid search filter');
  if (existing.scope?.kind === scope.kind && existing.scope.id === scope.id.toLowerCase()) return filter;
  const remainingFilter = removeSearchResourceScope(filter);
  const clauses: unknown[] = [searchResourceScopeClause(scope)];
  if (remainingFilter !== undefined) {
    let document: unknown;
    try {
      document = JSON.parse(remainingFilter);
    } catch {
      throw new Error('Invalid search filter');
    }
    if (isRecord(document) && Array.isArray(document.and) && Object.keys(document).length === 1)
      clauses.push(...document.and);
    else clauses.push(document);
  }
  return JSON.stringify(clauses.length === 1 ? clauses[0] : { and: clauses });
}

export function searchResourceScopeAction(locale: string, scope: SearchResourceScope): string {
  const filter = encodeURIComponent(JSON.stringify(searchResourceScopeClause(scope)));
  return `/${encodeURIComponent(locale)}/search?filter=${filter}`;
}

export function searchResourceScopeName(scope: SearchResourceScope): string {
  return `${scope.kind === 'realm' ? 'Realm' : 'Collection'} ${scope.id}`;
}
