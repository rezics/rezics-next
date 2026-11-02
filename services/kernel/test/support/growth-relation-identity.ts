export type RelationIdentity = {
  readonly database?: string;
  readonly schema?: string;
  readonly kind: 'relation' | 'index';
  readonly name: string;
};

export function relationIdentityKey(identity: RelationIdentity): string {
  return JSON.stringify([identity.database ?? null, identity.schema ?? null, identity.kind, identity.name]);
}

export function legacyRelationKey(identity: RelationIdentity): string {
  if (identity.kind === 'index') return `index:${identity.name}`;
  return identity.schema === undefined ? identity.name : `${identity.schema}.${identity.name}`;
}

export function relationIdentityLabel(identity: RelationIdentity): string {
  const kind = identity.kind === 'index' ? ' index' : '';
  return `${identity.database ?? '<unknown database>'}.${identity.schema ?? '<unknown schema>'}.${identity.name}${kind}`;
}

export const formatRelationIdentity = relationIdentityLabel;

export function relationIdentityMatches(candidate: RelationIdentity, requested: RelationIdentity): boolean {
  return (
    candidate.kind === requested.kind &&
    candidate.name === requested.name &&
    (requested.database === undefined || candidate.database === requested.database) &&
    (requested.schema === undefined || candidate.schema === requested.schema)
  );
}

/** Keeps familiar keys when unique and gives colliding relations stable identity-qualified keys. */
export function relationRecordKeys(identities: readonly RelationIdentity[]): ReadonlyMap<string, string> {
  const distinct = new Map<string, RelationIdentity>();
  for (const identity of identities) distinct.set(relationIdentityKey(identity), identity);

  const displayCounts = new Map<string, number>();
  for (const identity of distinct.values()) {
    const display = legacyRelationKey(identity);
    displayCounts.set(display, (displayCounts.get(display) ?? 0) + 1);
  }

  const reserved = new Set(displayCounts.keys());
  const used = new Set<string>();
  const keys = new Map<string, string>();
  for (const [identityKey, identity] of distinct) {
    const display = legacyRelationKey(identity);
    let candidate = display;
    if (displayCounts.get(display)! > 1) {
      const encoded = `@relation:${JSON.stringify([
        identity.database ?? null,
        identity.schema ?? null,
        identity.kind,
        identity.name,
      ])}`;
      candidate = encoded;
      let suffix = 1;
      while (used.has(candidate) || reserved.has(candidate)) candidate = `${encoded}#${suffix++}`;
    }
    used.add(candidate);
    keys.set(identityKey, candidate);
  }
  return keys;
}

export function keyedRelationEntries<T>(
  entries: readonly { readonly identity: RelationIdentity; readonly value: T }[],
): Readonly<Record<string, T>> {
  const keys = relationRecordKeys(entries.map(({ identity }) => identity));
  const output: Record<string, T> = {};
  const seen = new Set<string>();
  for (const { identity, value } of entries) {
    const identityKey = relationIdentityKey(identity);
    if (seen.has(identityKey)) throw new Error(`Duplicate relation identity ${relationIdentityLabel(identity)}`);
    seen.add(identityKey);
    const key = keys.get(identityKey);
    if (key === undefined) throw new Error(`Missing relation record key for ${relationIdentityLabel(identity)}`);
    output[key] = value;
  }
  return output;
}

/** Resolves partial plan evidence only when it maps to one catalog relation. */
export function resolveRelationIdentity(
  requested: RelationIdentity,
  catalog: readonly RelationIdentity[],
): RelationIdentity {
  const matches = new Map<string, RelationIdentity>();
  for (const candidate of catalog)
    if (relationIdentityMatches(candidate, requested)) matches.set(relationIdentityKey(candidate), candidate);

  if (matches.size === 0)
    throw new Error(
      `Measured relation ${relationIdentityLabel(requested)} has no pg_class footprint; confirm the captured database, schema, and relation evidence`,
    );
  if (matches.size > 1) {
    const candidates = [...matches.values()].map(relationIdentityLabel).join(', ');
    throw new Error(
      `Measured relation ${relationIdentityLabel(requested)} is ambiguous in pg_class (${candidates}); capture an explicit database and schema identity before checking its footprint`,
    );
  }
  return matches.values().next().value!;
}
