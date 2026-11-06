/** Maintained identity path as Search consumes it. Semantic owns publication of the mapping. */
export type SearchIdentityMapping =
  | Readonly<{ state: 'mapped'; original: string; terminal: string }>
  | Readonly<{ state: 'pending'; original: string }>
  | Readonly<{ state: 'absent' }>
  | Readonly<{ state: 'unavailable'; reason: string }>;

export type CanonicalHitKey = Readonly<{ original: string; terminal: string }>;
export type CanonicalKeysetAdmission<T extends { id: string }> =
  | Readonly<{
      status: 'ready';
      accepted: ReadonlyMap<T, T>;
      keys: ReadonlyMap<string, CanonicalHitKey>;
      canonicalId: (value: T) => string;
    }>
  | Readonly<{ status: 'preparing' }>;

/** Admitted operands Search, facets and typeahead bind into one confidential request. */
export type ExecutedSearchOperands = Readonly<{
  text?: string;
  filter?: unknown;
  sort?: string;
  population?: Readonly<{ realm: string }>;
  limit?: number;
  languages?: readonly string[];
  properties?: readonly string[];
  descriptions?: boolean;
  spoilerThreshold?: number;
}>;

export type ExecutedRatingPair = Readonly<{
  sort: string | null;
  population: Readonly<{ realm: string }> | null;
}>;

export type ExecutedSearchRequest = Readonly<{
  principal: string;
  identityEpoch: string;
  operands: ExecutedSearchOperands;
}>;

/** Rating order and selected population travel as one executed pair; recovery restarts both. */
export function executedRatingPair(operands: ExecutedSearchOperands): ExecutedRatingPair {
  return {
    sort: operands.sort ?? null,
    population: operands.population ?? null,
  };
}

export function executedSearchOperands(request: ExecutedSearchOperands): ExecutedSearchOperands {
  return {
    ...(request.text === undefined ? {} : { text: request.text }),
    ...(request.filter === undefined ? {} : { filter: request.filter }),
    ...(request.sort === undefined ? {} : { sort: request.sort }),
    ...(request.population === undefined ? {} : { population: request.population }),
    ...(request.limit === undefined ? {} : { limit: request.limit }),
    ...(request.languages === undefined ? {} : { languages: [...request.languages] }),
    ...(request.properties === undefined ? {} : { properties: [...request.properties] }),
    ...(request.descriptions ? { descriptions: true } : {}),
    ...(request.spoilerThreshold === undefined ? {} : { spoilerThreshold: request.spoilerThreshold }),
  };
}

export function bindExecutedSearchRequest(
  principal: string,
  identityEpoch: string,
  operands: ExecutedSearchOperands,
): ExecutedSearchRequest {
  if (principal !== 'anonymous' && !/^account:.+$/.test(principal))
    throw new TypeError('Invalid Search executed principal');
  return {
    principal,
    identityEpoch,
    operands: executedSearchOperands(operands),
  };
}

/** Bind the published identity epoch into the same request object the cursor already authenticates. */
export function bindSearchIdentityCursorRequest(request: unknown, identityEpoch: string): Record<string, unknown> {
  if (typeof identityEpoch !== 'string' || !identityEpoch || identityEpoch.length > 128)
    throw new TypeError('Invalid Search identity epoch');
  const record =
    request !== null && typeof request === 'object' && !Array.isArray(request)
      ? (request as Record<string, unknown>)
      : { request };
  return { ...record, identityEpoch };
}

/**
 * Unique canonical traversal: original AND terminal authority, one row per terminal.
 * Identity must be published, including self mappings. Absent, pending or unavailable
 * identity prepares. Hidden originals with a readable terminal remain. Stale indexed
 * originals whose terminal is absent from the page prepare rather than omit.
 */
export function admitCanonicalKeyset<T extends { id: string }>(
  subjects: readonly T[],
  mappings: readonly SearchIdentityMapping[],
): CanonicalKeysetAdmission<T> {
  if (subjects.length !== mappings.length)
    throw new TypeError('Canonical keyset mappings must match the page subjects');
  const byOriginal = new Map<string, T>();
  for (const subject of subjects) {
    if (byOriginal.has(subject.id)) continue;
    byOriginal.set(subject.id, subject);
  }
  const keys = new Map<string, CanonicalHitKey>();
  const accepted = new Map<T, T>();
  const terminalsOnPage = new Set<string>();
  for (const [index, subject] of subjects.entries()) {
    const mapping = mappings[index]!;
    if (mapping.state !== 'mapped') return { status: 'preparing' };
    keys.set(subject.id, { original: mapping.original, terminal: mapping.terminal });
    if (subject.id === mapping.terminal) terminalsOnPage.add(mapping.terminal);
  }
  for (const subject of subjects) {
    const key = keys.get(subject.id);
    if (!key) continue;
    if (subject.id === key.terminal) {
      accepted.set(subject, subject);
      continue;
    }
    if (subject.id !== key.original) return { status: 'preparing' };
    const terminal = byOriginal.get(key.terminal);
    if (!terminal && !terminalsOnPage.has(key.terminal)) return { status: 'preparing' };
    if (terminal) accepted.set(terminal, terminal);
  }
  return {
    status: 'ready',
    accepted,
    keys,
    canonicalId: (value) => keys.get(value.id)?.terminal ?? value.id,
  };
}
