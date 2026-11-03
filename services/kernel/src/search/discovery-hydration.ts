import type { Pool } from 'pg';
import { accountDiscoverySource, readAccountDiscoverySummaries } from '../access/account-discovery-source.ts';
import { readSubjectSummaries } from '../semantic/summaries.ts';
import type {
  DiscoveryOwnerHit,
  DiscoveryOwnerKey,
  DiscoveryOwnerAdapterSlots,
  DiscoveryOwnerKind,
  DiscoveryOwnerMetadataSummary,
  DiscoveryOwnerRegistry,
  DiscoveryReadContext,
  DiscoveryRegistryOptions,
  DiscoveryUnionKey,
} from './discovery.ts';
import { createDiscoveryRegistry } from './discovery-registry.ts';
import { routeOf } from '../route/route.ts';

/** Native owner assembly. Accounts never pass through SubjectSource or attribution readers.
 * The caller pins release/metadata and language preferences before entering its safety envelope.
 */
export function createNativeDiscoveryRegistry(options: {
  pool: Pool;
  routeKey: Uint8Array;
  release: DiscoveryRegistryOptions['release'];
  semantic: Pick<DiscoveryRegistryOptions['semantic'], 'source' | 'icons'>;
  accounts: Pick<DiscoveryRegistryOptions['accounts'], 'labels' | 'icon'>;
  ownerAdapters?: DiscoveryOwnerAdapterSlots;
  languages?: readonly string[];
}) {
  const { pool, routeKey, languages = [] } = options;
  return createDiscoveryRegistry({
    release: options.release,
    semantic: {
      ...options.semantic,
      async hydrate(ids, context) {
        const summaries = await readSubjectSummaries({ pool, routeKey, ...context }, ids, { languages });
        return new Map([...summaries].flatMap(([id, summary]) => (summary ? [[id, summary]] : [])));
      },
    },
    accounts: {
      ...options.accounts,
      source: accountDiscoverySource(pool),
      async hydrate(ids, context) {
        const summaries = await readAccountDiscoverySummaries({ pool, routeKey, ...context }, ids, { languages });
        return new Map([...summaries].flatMap(([id, summary]) => (summary ? [[id, summary]] : [])));
      },
    },
    ...(options.ownerAdapters ? { ownerAdapters: options.ownerAdapters } : {}),
  });
}

export type DiscoveryOwnerCandidate = Readonly<{
  key: DiscoveryOwnerKey;
  sourcePosition: string;
  revision: string;
  sourceVersion?: string | null;
}>;

const MAX_NATIVE_REVISION = 9_223_372_036_854_775_807n;
function decimal(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^(0|[1-9][0-9]{0,18})$/.test(value) &&
    BigInt(value) <= MAX_NATIVE_REVISION
  );
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
  if (!object(value) || value.id !== id || !validText(value.sourcePosition) || !decimal(value.sourcePosition)) return false;
  if (kind === 'collection') {
    return (
      Object.keys(value).length === 6 &&
      ['id', 'title', 'summary', 'revision', 'sourcePosition', 'card'].every((key) => Object.hasOwn(value, key)) &&
      validText(value.title) &&
      validNullableText(value.summary) &&
      decimal(value.revision) &&
      object(value.card) &&
      value.card.id === id &&
      value.card.title === value.title &&
      value.card.description === value.summary &&
      value.card.revision === Number(value.revision)
    );
  }
  if (kind === 'review') {
    return (
      Object.keys(value).length === 7 &&
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
    Object.keys(value).length === 9 &&
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

async function readBatches<T>(
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

/** Hydrate the current full owner page first, then add only current public review and Space context. */
export async function hydrateOwnerDiscoveryHits(
  registry: ReturnType<typeof createDiscoveryRegistry> & DiscoveryOwnerRegistry,
  candidates: readonly DiscoveryOwnerCandidate[],
  context: DiscoveryReadContext,
): Promise<readonly (DiscoveryOwnerHit | undefined)[]> {
  if (candidates.length > 200) throw new RangeError('Discovery hydration exceeds its owner bound');
  const canonical = candidates.map((candidate) => ({
    ...candidate,
    key: registry.ownerKey(candidate.key),
  }));
  const idsByKind = new Map<DiscoveryOwnerKind, string[]>();
  for (const { key } of canonical) {
    const ids = idsByKind.get(key.kind) ?? [];
    ids.push(key.id);
    idsByKind.set(key.kind, ids);
  }
  const current = new Map<string, DiscoveryOwnerMetadataSummary>();
  for (const [kind, ids] of idsByKind) {
    const adapter = registry.getOwnerAdapter(kind);
    const summaries = await adapter.readCurrent(ids, context);
    if (!summaries || typeof summaries.get !== 'function' || typeof summaries[Symbol.iterator] !== 'function')
      throw new TypeError('Owner discovery adapter returned an invalid current summary set');
    const requested = new Set(ids);
    for (const [id, summary] of summaries) {
      if (!requested.has(id) || !validOwnerSummary(kind, summary, id))
        throw new TypeError('Owner discovery adapter returned a foreign or invalid current summary');
      current.set(`${kind}:${id}`, summary);
    }
  }

  const accepted = canonical.map((candidate) => {
    const { key } = candidate;
    const value = current.get(`${key.kind}:${key.id}`);
    if (!value) return undefined;
    if (BigInt(candidate.sourcePosition) > BigInt(value.sourcePosition))
      throw new TypeError('Owner discovery source position exceeds its current observation');
    if (key.kind === 'collection' || key.kind === 'space') {
      if (value.revision !== candidate.revision) return undefined;
    } else if (!candidate.sourceVersion || value.sourceVersion !== candidate.sourceVersion) return undefined;
    if (key.kind === 'space' && value.address === null) return undefined;
    return { candidate, value };
  });

  const reviewRows = accepted.flatMap((entry) =>
    entry?.candidate.key.kind === 'review' ? [entry] : [],
  );
  const authorIds = reviewRows.map((entry) => (entry.value as Extract<DiscoveryOwnerMetadataSummary, { authorId: string }>).authorId);
  const subjectIds = reviewRows.map((entry) => (entry.value as Extract<DiscoveryOwnerMetadataSummary, { subjectId: string }>).subjectId);
  const accountEntry = registry.get('account');
  if (accountEntry.owner !== 'accounts') throw new TypeError('Discovery Account hydrator is unavailable');
  const accountSummaries = await readBatches(authorIds, (ids) => accountEntry.hydrate(ids, context));
  const semanticEntry = registry.entries.find((entry) => entry.owner === 'semantic');
  const subjectSummaries = semanticEntry
    ? await readBatches(subjectIds, (ids) => semanticEntry.hydrate(ids, context))
    : new Map();

  return accepted.map((entry): DiscoveryOwnerHit | undefined => {
    if (!entry) return undefined;
    const { candidate, value } = entry;
    const key = publicKey(candidate.key);
    switch (candidate.key.kind) {
      case 'collection':
        return {
          key,
          summary: {
            kind: 'collection',
            value: { id: value.id, title: value.title, description: value.summary },
          },
        };
      case 'review': {
        const review = value as Extract<DiscoveryOwnerMetadataSummary, { authorId: string }>;
        const author = accountSummaries.get(review.authorId);
        const subject = subjectSummaries.get(review.subjectId);
        return {
          key,
          summary: {
            kind: 'review',
            value: {
              id: review.id,
              kind: 'review',
              title: review.title,
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
          key,
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
