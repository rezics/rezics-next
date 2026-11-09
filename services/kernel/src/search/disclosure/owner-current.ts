import { isDeepStrictEqual } from 'node:util';
import { routeOf } from '../../route/route.ts';
import { OwnerCurrentRestartRequired } from '../operation-outcomes.ts';
import type {
  DiscoveryOwnerHit,
  DiscoveryOwnerKey,
  DiscoveryOwnerKind,
  DiscoveryOwnerMetadataSummary,
  DiscoveryReadContext,
  AccountDiscoverySummary,
} from '../discovery.ts';

export type DiscoveryOwnerCandidate = Readonly<{
  key: DiscoveryOwnerKey;
  sourcePosition: string;
  revision: string;
  sourceVersion?: string | null;
}>;
export type OwnerCurrentAccepted<Candidate> = Readonly<{
  candidate: Candidate;
  kind: DiscoveryOwnerKind;
  id: string;
  value: DiscoveryOwnerMetadataSummary;
}>;
/** Owner reads retain the caller's reader, request and identity epoch by identity. */
export type OwnerCurrentPorts = Readonly<{
  readCurrent(
    kind: DiscoveryOwnerKind,
    ids: readonly string[],
    context: DiscoveryReadContext,
  ): Promise<ReadonlyMap<string, DiscoveryOwnerMetadataSummary>>;
}>;
export type OwnerDisclosurePorts = OwnerCurrentPorts &
  Readonly<{
    ownerKey(key: DiscoveryOwnerKey): DiscoveryOwnerKey;
    hydrateAccounts(
      ids: readonly string[],
      context: DiscoveryReadContext,
    ): Promise<ReadonlyMap<string, AccountDiscoverySummary>>;
    hydrateSubjects(
      ids: readonly string[],
      context: DiscoveryReadContext,
    ): Promise<ReadonlyMap<string, { id: string; label?: { value: string } | null }>>;
  }>;
export { OwnerCurrentRestartRequired } from '../operation-outcomes.ts';

const MAX_NATIVE_REVISION = 9_223_372_036_854_775_807n;
function decimal(value: unknown): value is string {
  return typeof value === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(value) && BigInt(value) <= MAX_NATIVE_REVISION;
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function validText(value: unknown): value is string {
  return typeof value === 'string' && value.isWellFormed();
}
function validNullableText(value: unknown): value is string | null {
  return value === null || validText(value);
}

function validOwnerSummary(
  kind: DiscoveryOwnerKind,
  value: unknown,
  id: string,
): value is DiscoveryOwnerMetadataSummary {
  if (!object(value) || value.id !== id || !validText(value.sourcePosition) || !decimal(value.sourcePosition))
    return false;
  if (kind === 'collection') {
    return (
      Object.keys(value).length === 8 &&
      ['id', 'title', 'summary', 'revision', 'sourcePosition', 'queryObservation', 'card', 'operands'].every((key) =>
        Object.hasOwn(value, key),
      ) &&
      validText(value.title) &&
      validNullableText(value.summary) &&
      decimal(value.revision) &&
      typeof value.queryObservation === 'string' &&
      /^[a-f0-9]{64}$/.test(value.queryObservation) &&
      object(value.operands) &&
      value.operands.id === id &&
      object(value.card) &&
      value.card.id === id &&
      value.card.title === value.title &&
      value.card.description === value.summary &&
      value.card.revision === Number(value.revision)
    );
  }
  if (kind === 'review') {
    return (
      Object.keys(value).length === (Object.hasOwn(value, 'source') ? 8 : 7) &&
      (!Object.hasOwn(value, 'source') ||
        (object(value.source) &&
          Object.keys(value.source).length === 2 &&
          typeof value.source.openingRevisionId === 'string' &&
          routeOf(value.source.openingRevisionId) !== null &&
          value.source.sourceVersion === value.sourceVersion)) &&
      ['id', 'title', 'summary', 'sourceVersion', 'sourcePosition', 'authorId', 'subjectId'].every((key) =>
        Object.hasOwn(value, key),
      ) &&
      validNullableText(value.title) &&
      validNullableText(value.summary) &&
      validText(value.sourceVersion) &&
      value.sourceVersion.length > 0 &&
      value.sourceVersion.length <= 128 &&
      typeof value.authorId === 'string' &&
      routeOf(value.authorId) !== null &&
      typeof value.subjectId === 'string' &&
      routeOf(value.subjectId) !== null
    );
  }
  return (
    Object.keys(value).length === 8 &&
    ['id', 'title', 'summary', 'revision', 'sourcePosition', 'address', 'realmId', 'realmTitle'].every((key) =>
      Object.hasOwn(value, key),
    ) &&
    validText(value.title) &&
    validNullableText(value.summary) &&
    decimal(value.revision) &&
    validNullableText(value.address) &&
    (value.address === null || (value.address.length > 0 && [...value.address].length <= 256)) &&
    validNullableText(value.realmTitle) &&
    (value.realmId === null || (typeof value.realmId === 'string' && routeOf(value.realmId) !== null))
  );
}

function publicKey(key: DiscoveryOwnerKey): DiscoveryOwnerHit['key'] {
  switch (key.kind) {
    case 'collection':
      return { owner: 'library', kind: 'collection', route: key.route, id: key.id };
    case 'review':
      return { owner: 'content', kind: 'review', route: key.route, id: key.id };
    case 'space':
      return { owner: 'community', kind: 'space', route: key.route, id: key.id };
  }
}

export async function readOwnerBatches<T>(
  ids: readonly string[],
  read: (ids: readonly string[]) => Promise<ReadonlyMap<string, T>>,
): Promise<Map<string, T>> {
  const result = new Map<string, T>();
  for (let offset = 0; offset < ids.length; offset += 100) {
    const batch = ids.slice(offset, offset + 100);
    const values = await read(batch);
    if (!values || typeof values.get !== 'function' || typeof values[Symbol.iterator] !== 'function')
      throw new TypeError('Discovery context hydration did not return a keyed map');
    for (const [id, value] of values) {
      if (!batch.includes(id)) throw new TypeError('Discovery context hydration returned a foreign identity');
      result.set(id, value);
    }
  }
  return result;
}

export function ownerSummaryUnchanged(
  kind: DiscoveryOwnerKind,
  before: DiscoveryOwnerMetadataSummary,
  after: DiscoveryOwnerMetadataSummary | undefined,
): boolean {
  if (!after) return false;
  return isDeepStrictEqual(before, after);
}

export async function revalidateOwnerCurrentSummaries<Candidate>(
  ports: OwnerCurrentPorts,
  accepted: readonly (OwnerCurrentAccepted<Candidate> | undefined)[],
  context: DiscoveryReadContext,
): Promise<readonly (OwnerCurrentAccepted<Candidate> | undefined)[]> {
  const idsByKind = new Map<DiscoveryOwnerKind, string[]>();
  for (const entry of accepted) {
    if (!entry) continue;
    const ids = idsByKind.get(entry.kind) ?? [];
    ids.push(entry.id);
    idsByKind.set(entry.kind, ids);
  }
  const current = new Map<string, DiscoveryOwnerMetadataSummary>();
  for (const [kind, ids] of idsByKind) {
    const unique = [...new Set(ids)];
    for (let offset = 0; offset < unique.length; offset += 100) {
      const batch = unique.slice(offset, offset + 100);
      const summaries = await ports.readCurrent(kind, batch, context);
      if (!summaries || typeof summaries.get !== 'function' || typeof summaries[Symbol.iterator] !== 'function')
        throw new TypeError('Owner discovery adapter returned an invalid current summary set');
      const requested = new Set(batch);
      for (const [id, summary] of summaries) {
        if (!requested.has(id)) throw new TypeError('Owner discovery adapter returned a foreign current summary');
        current.set(`${kind}:${id}`, summary);
      }
    }
  }
  return accepted.map((entry) => {
    if (!entry) return undefined;
    const after = current.get(`${entry.kind}:${entry.id}`);
    if (!after) return undefined;
    if (!ownerSummaryUnchanged(entry.kind, entry.value, after)) throw new OwnerCurrentRestartRequired();
    return entry;
  });
}

export async function readOwnerCandidates(
  ports: OwnerDisclosurePorts,
  candidates: readonly DiscoveryOwnerCandidate[],
  context: DiscoveryReadContext,
) {
  if (candidates.length > 200) throw new RangeError('Discovery hydration exceeds its owner bound');
  const canonical = candidates.map((candidate) => ({
    ...candidate,
    key: ports.ownerKey(candidate.key),
  }));
  const idsByKind = new Map<DiscoveryOwnerKind, string[]>();
  for (const { key } of canonical) {
    const ids = idsByKind.get(key.kind) ?? [];
    ids.push(key.id);
    idsByKind.set(key.kind, ids);
  }
  const current = new Map<string, DiscoveryOwnerMetadataSummary>();
  for (const [kind, ids] of idsByKind) {
    const summaries = await readOwnerBatches<DiscoveryOwnerMetadataSummary>([...new Set(ids)], (batch) =>
      ports.readCurrent(kind, batch, context),
    );
    if (!summaries || typeof summaries.get !== 'function' || typeof summaries[Symbol.iterator] !== 'function')
      throw new TypeError('Owner discovery adapter returned an invalid current summary set');
    const requested = new Set(ids);
    for (const [id, summary] of summaries) {
      if (!requested.has(id) || !validOwnerSummary(kind, summary, id))
        throw new TypeError('Owner discovery adapter returned a foreign or invalid current summary');
      current.set(`${kind}:${id}`, structuredClone(summary));
    }
  }

  const accepted = canonical.map((candidate) => {
    const { key } = candidate;
    const value = current.get(`${key.kind}:${key.id}`);
    if (!value) return undefined;
    if (BigInt(candidate.sourcePosition) > BigInt(value.sourcePosition))
      throw new TypeError('Owner discovery source position exceeds its current observation');
    if (key.kind === 'collection') {
      if ((value as DiscoveryOwnerMetadataSummary<'collection'>).revision !== candidate.revision) return undefined;
    } else if (key.kind === 'space') {
      const space = value as DiscoveryOwnerMetadataSummary<'space'>;
      if (space.revision !== candidate.revision || space.address === null) return undefined;
    } else {
      const review = value as DiscoveryOwnerMetadataSummary<'review'>;
      if (!candidate.sourceVersion || review.sourceVersion !== candidate.sourceVersion) return undefined;
    }
    return { candidate, kind: key.kind, id: key.id, value };
  });

  return accepted;
}

export function projectOwnerHits(
  accepted: readonly (OwnerCurrentAccepted<DiscoveryOwnerCandidate> | undefined)[],
  accountSummaries: ReadonlyMap<string, AccountDiscoverySummary>,
  subjectSummaries: ReadonlyMap<string, { id: string; label?: { value: string } | null }>,
): readonly (DiscoveryOwnerHit | undefined)[] {
  return accepted.map((entry): DiscoveryOwnerHit | undefined => {
    if (!entry) return undefined;
    const { candidate, value } = entry;
    const key = publicKey(candidate.key);
    switch (candidate.key.kind) {
      case 'collection': {
        const collection = value as Extract<DiscoveryOwnerMetadataSummary, { card: unknown }>;
        return {
          key: key as Extract<typeof key, { kind: 'collection' }>,
          summary: {
            kind: 'collection',
            value: {
              id: collection.id,
              title: collection.title,
              description: collection.summary,
              card: structuredClone(collection.card),
            },
          },
        };
      }
      case 'review': {
        const review = value as Extract<DiscoveryOwnerMetadataSummary, { authorId: string }>;
        const author = accountSummaries.get(review.authorId);
        const subject = subjectSummaries.get(review.subjectId);
        return {
          key: key as Extract<typeof key, { kind: 'review' }>,
          summary: {
            kind: 'review',
            value: {
              id: review.id,
              kind: 'review',
              title: review.title,
              ...(review.source ? { source: { ...review.source } } : {}),
              ...(author ? { author: { displayName: author.displayName, handle: author.handle } } : {}),
              ...(review.summary === null ? {} : { excerpt: review.summary }),
              ...(subject ? { subject: { id: subject.id, title: subject.label?.value ?? null } } : {}),
            },
          },
        };
      }
      case 'space': {
        const space = value as Extract<DiscoveryOwnerMetadataSummary, { address: string | null }>;
        if (!space.address) return undefined;
        return {
          key: key as Extract<typeof key, { kind: 'space' }>,
          summary: {
            kind: 'space',
            value: {
              id: space.id,
              title: space.title,
              address: space.address,
              ...(space.summary === null ? {} : { summary: space.summary }),
              ...(space.realmId ? { realm: { id: space.realmId, title: space.realmTitle } } : {}),
            },
          },
        };
      }
    }
  });
}
