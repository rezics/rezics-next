import { relationFacetProperty, type DiscoveryFilterDocument, type FilterRelease } from '@rezics/filter';
import { partitionOf, routeOf } from '../route/route.ts';
import { validateAccountSnapshot } from './account-discovery.ts';
import {
  MAX_ACCOUNT_DISCOVERY_BATCH,
  type DiscoveryHit,
  type DiscoveryReadContext,
  type DiscoveryRegistry,
  type IndexedAccount,
  type DiscoveryEngineHit,
  type DiscoveryKey,
  type DiscoveryRegistration,
  type AccountSnapshot,
} from './discovery.ts';
import type { DiscoveryCandidate } from './discovery-query.ts';
import { currentDiscoveryFilter } from './discovery-filter.ts';
import { checkHits } from './disclosure/check.ts';
import { SearchUnavailableError } from './opensearch.ts';
import { validateRequestSourceSnapshot } from './request-source-snapshot.ts';
import type { IndexedSubject, SubjectSnapshot, SubjectSource } from './source.ts';

function unavailable(): never {
  throw new SearchUnavailableError('Current discovery owner evidence is unavailable or malformed');
}
function requireCurrentOwner(registry: DiscoveryRegistry, key: DiscoveryKey): void {
  const owner = String(registry.get(key.kind).owner);
  if (owner !== String(key.owner) || (owner !== 'semantic' && owner !== 'accounts')) unavailable();
}
function partitioned<T extends { id: string }>(values: readonly T[]): Map<number, T[]> {
  const groups = new Map<number, T[]>();
  for (const value of values) {
    const route = routeOf(value.id);
    if (route === null) unavailable();
    const partition = partitionOf(route);
    const group = groups.get(partition) ?? [];
    if (!groups.has(partition)) groups.set(partition, group);
    group.push(value);
  }
  return groups;
}

/** One bounded positional owner batch for original primary keys, including duplicate positions.
 * The initial native snapshots supply their own revisions; an attached summary or engine hit
 * cannot supply one. Reuse those exact snapshots in the ordinary current/disclosure checker,
 * rather than observing the owners a second time to reconstruct synthetic engine candidates.
 */
export async function currentDiscoveryPrimaryCandidates(
  registry: DiscoveryRegistry,
  keys: readonly DiscoveryKey[],
  filter: DiscoveryFilterDocument | undefined,
  release: FilterRelease,
  context: DiscoveryReadContext,
): Promise<readonly boolean[]> {
  if (!Array.isArray(keys) || keys.length > 160) unavailable();
  const saved = keys.map((key) => registry.key({ ...key }));
  for (const key of saved) requireCurrentOwner(registry, key);
  const subjects = new Map<number, SubjectSnapshot>();
  const accounts = new Map<number, AccountSnapshot>();
  const candidates: DiscoveryEngineHit[] = [];
  const byIdentity = new Map<string, DiscoveryEngineHit>();
  const identity = (key: DiscoveryKey) => `${key.owner}:${key.kind}:${key.route}:${key.id}`;
  for (const owner of ['semantic', 'accounts'] as const) {
    const selected = saved.filter((key) => key.owner === owner);
    if (!selected.length) continue;
    const entry = registry.entries.find((value) => value.owner === owner);
    if (!entry) unavailable();
    for (const [partition, group] of partitioned(selected)) {
      const ids = [...new Set(group.map(({ id }) => id))];
      if (entry.owner === 'semantic') {
        const snapshot = await entry.source.read(partition, ids);
        const current = validateRequestSourceSnapshot(snapshot, partition, ids);
        subjects.set(partition, snapshot);
        for (const key of group) {
          const row = current.get(key.id);
          if (!row || row.type !== key.kind || byIdentity.has(identity(key))) continue;
          const candidate = {
            key,
            index: '',
            sourcePosition: snapshot.position.toString(),
            revision: String(row.securityRevision),
            matched: [],
            sort: [],
          };
          candidates.push(candidate);
          byIdentity.set(identity(key), candidate);
        }
      } else {
        const rows: IndexedAccount[] = [];
        let position: bigint | undefined;
        for (let offset = 0; offset < ids.length; offset += 100) {
          const chunk = ids.slice(offset, offset + 100);
          const snapshot = await entry.source.read(partition, chunk);
          if (
            snapshot.partition !== partition ||
            typeof snapshot.position !== 'bigint' ||
            snapshot.position < 0n ||
            !Array.isArray(snapshot.accounts) ||
            snapshot.accounts.length > chunk.length ||
            (position !== undefined && position !== snapshot.position)
          )
            unavailable();
          const seen = new Set<string>();
          for (const row of snapshot.accounts) {
            if (!chunk.includes(row.id) || seen.has(row.id) || typeof row.revision !== 'bigint' || row.revision < 0n)
              unavailable();
            seen.add(row.id);
            rows.push(row);
          }
          position = snapshot.position;
        }
        const snapshot = { partition, position: position!, accounts: rows };
        accounts.set(partition, snapshot);
        for (const key of group) {
          const row = rows.find((value) => value.id === key.id);
          if (!row || byIdentity.has(identity(key))) continue;
          const candidate = {
            key,
            index: '',
            sourcePosition: snapshot.position.toString(),
            revision: row.revision.toString(),
            matched: [],
            sort: [],
          };
          candidates.push(candidate);
          byIdentity.set(identity(key), candidate);
        }
      }
    }
  }
  const entries: DiscoveryRegistration[] = registry.entries.map((entry) =>
    entry.owner === 'semantic'
      ? {
          ...entry,
          source: {
            ...entry.source,
            count: entry.source.count.bind(entry.source),
            ...(entry.source.matchRelationFacets
              ? { matchRelationFacets: entry.source.matchRelationFacets.bind(entry.source) }
              : {}),
            async read(partition, ids) {
              const snapshot = subjects.get(partition);
              if (!snapshot || ids.some((id) => !saved.some((key) => key.owner === 'semantic' && key.id === id)))
                unavailable();
              return { ...snapshot, subjects: snapshot.subjects.filter((row) => ids.includes(row.id)) };
            },
          },
        }
      : {
          ...entry,
          source: {
            count: entry.source.count.bind(entry.source),
            page: entry.source.page.bind(entry.source),
            async read(partition, ids) {
              const snapshot = accounts.get(partition);
              if (!snapshot || ids.some((id) => !saved.some((key) => key.owner === 'accounts' && key.id === id)))
                unavailable();
              return { ...snapshot, accounts: snapshot.accounts.filter((row) => ids.includes(row.id)) };
            },
          },
        },
  );
  const retained: DiscoveryRegistry = {
    entries,
    key: registry.key.bind(registry),
    get(kind) {
      const entry = entries.find((value) => value.kind === kind);
      if (!entry) unavailable();
      return entry;
    },
  };
  const current = await currentDiscoveryCandidates(retained, candidates, filter, release, context);
  return Object.freeze(
    saved.map((key) => {
      const candidate = byIdentity.get(identity(key));
      return candidate !== undefined && current.has(candidate);
    }),
  );
}

/** Membership/summary checking only. Whole-query exclusion/order safety must bracket this operation
 * through the canonical native Source and consumer; returned candidates alone never certify a page.
 */
export async function currentDiscoveryCandidates<Candidate extends DiscoveryCandidate | DiscoveryEngineHit>(
  registry: DiscoveryRegistry,
  candidates: readonly Candidate[],
  filter: DiscoveryFilterDocument | undefined,
  release: FilterRelease,
  context: DiscoveryReadContext,
): Promise<Map<Candidate, DiscoveryHit>> {
  if (candidates.length > 200) unavailable();
  const passed = new Map<Candidate, DiscoveryHit>();
  for (const candidate of candidates) {
    registry.key(candidate.key);
    requireCurrentOwner(registry, candidate.key);
    if (
      'revision' in candidate &&
      (!/^(0|[1-9][0-9]{0,18})$/.test(candidate.revision) ||
        BigInt(candidate.revision) > 9_223_372_036_854_775_807n ||
        !/^(0|[1-9][0-9]{0,18})$/.test(candidate.sourcePosition))
    )
      unavailable();
  }
  // One Subject row-kind read per partition/chunk, shared across every configured catalogue kind.
  const semantic = candidates.filter((candidate) => candidate.key.owner === 'semantic');
  const snapshots = new Map<number, SubjectSnapshot>();
  const source = registry.entries.find((entry) => entry.owner === 'semantic')?.source;
  if (semantic.length && !source) unavailable();
  if (source) {
    for (const [partition, group] of partitioned(semantic.map(({ key }) => key))) {
      const subjects: IndexedSubject[] = [];
      let position: bigint | undefined;
      const ids = [...new Set(group.map(({ id }) => id))];
      for (let offset = 0; offset < ids.length; offset += 256) {
        const chunk = ids.slice(offset, offset + 256);
        const snapshot = await source.read(partition, chunk);
        subjects.push(...validateRequestSourceSnapshot(snapshot, partition, chunk).values());
        if (position !== undefined && position !== snapshot.position) unavailable();
        position = snapshot.position;
      }
      if (
        semantic.some(
          (candidate) =>
            partitionOf(candidate.key.route) === partition &&
            'sourcePosition' in candidate &&
            BigInt(candidate.sourcePosition) > position!,
        )
      )
        unavailable();
      snapshots.set(partition, { partition, position: position!, subjects });
    }
    const cached: SubjectSource = {
      count: source.count.bind(source),
      ...(source.matchRelationFacets ? { matchRelationFacets: source.matchRelationFacets.bind(source) } : {}),
      async read(partition, ids) {
        const snapshot = snapshots.get(partition);
        if (!snapshot) unavailable();
        return { ...snapshot, subjects: snapshot.subjects.filter((subject) => ids.includes(subject.id)) };
      },
    };
    const selectedSemantic: Candidate[] = [];
    for (const entry of registry.entries) {
      if (entry.owner !== 'semantic') continue;
      const group = semantic.filter(({ key }) => key.kind === entry.kind);
      if (!group.length) continue;
      const currentFilter = filter ? currentDiscoveryFilter(filter, registry, entry.kind, release) : true;
      if (currentFilter === false) continue;
      const hits = group.map((candidate) => {
        const revision =
          'document' in candidate && candidate.document.owner === 'semantic'
            ? candidate.document.security_revision
            : 'revision' in candidate
              ? Number(candidate.revision)
              : NaN;
        if (!Number.isSafeInteger(revision) || revision < 0) unavailable();
        return {
          id: candidate.key.id,
          partition: partitionOf(candidate.key.route),
          securityRevision: revision,
          matched: [],
        };
      });
      const checked = await checkHits(cached, hits, new Map(), {
        ...(currentFilter === true ? {} : { filter: currentFilter }),
        relationProperties: Object.keys(release.properties).filter((property) =>
          relationFacetProperty(release, property),
        ),
      });
      const accepted = new Set(
        checked.passed.filter(({ subject }) => subject.type === entry.kind).map(({ subject }) => subject.id),
      );
      selectedSemantic.push(...group.filter(({ key }) => accepted.has(key.id)));
    }
    const semanticEntry = registry.entries.find((entry) => entry.owner === 'semantic');
    if (selectedSemantic.length && semanticEntry) {
      // All catalogue registrations share one native hydrator, independent of selected kind count.
      const summaries = await semanticEntry.hydrate([...new Set(selectedSemantic.map(({ key }) => key.id))], context);
      for (const candidate of selectedSemantic) {
        const summary = summaries.get(candidate.key.id);
        if (summary && summary.id === candidate.key.id && summary.type === candidate.key.kind)
          passed.set(candidate, { key: candidate.key, summary: { kind: 'subject', value: summary } });
      }
    }
  }
  const accounts = candidates.filter(({ key }) => key.owner === 'accounts');
  if (!accounts.length) return passed;
  const entry = registry.get('account');
  if (entry.owner !== 'accounts') unavailable();
  if (filter && currentDiscoveryFilter(filter, registry, entry.kind, release) !== true) return passed;
  const selectedAccounts = new Map<Candidate, IndexedAccount>();
  // Admit every native Account chunk before hydration; a later invalid chunk must not publish a prefix.
  for (const [partition, group] of partitioned(accounts.map(({ key }) => key))) {
    const ids = [...new Set(group.map(({ id }) => id))];
    const current = new Map<string, IndexedAccount>();
    for (let offset = 0; offset < ids.length; offset += MAX_ACCOUNT_DISCOVERY_BATCH) {
      const chunk = ids.slice(offset, offset + MAX_ACCOUNT_DISCOVERY_BATCH);
      const observed = await entry.source.read(partition, chunk);
      let snapshot;
      try {
        snapshot = validateAccountSnapshot(observed, partition, chunk, 0n);
      } catch {
        unavailable();
      }
      if (
        accounts.some(
          (candidate) =>
            chunk.includes(candidate.key.id) &&
            'sourcePosition' in candidate &&
            BigInt(candidate.sourcePosition) > snapshot.position,
        )
      )
        unavailable();
      for (const account of snapshot.accounts) current.set(account.id, account);
    }
    const selected = accounts.filter((candidate) => {
      const row = current.get(candidate.key.id);
      if (!row || partitionOf(candidate.key.route) !== partition) return false;
      if ('revision' in candidate) return row.revision.toString() === candidate.revision;
      const document = candidate.document;
      return (
        document.owner === 'accounts' &&
        row.revision.toString() === document.revision &&
        row.handle === document.handle &&
        row.displayName === document.display_name &&
        row.accountKind === document.account_kind
      );
    });
    for (const candidate of selected) selectedAccounts.set(candidate, current.get(candidate.key.id)!);
  }
  const selected = [...selectedAccounts.keys()];
  for (let offset = 0; offset < selected.length; offset += MAX_ACCOUNT_DISCOVERY_BATCH) {
    const chunk = selected.slice(offset, offset + MAX_ACCOUNT_DISCOVERY_BATCH);
    const summaries = await entry.hydrate(
      chunk.map(({ key }) => key.id),
      context,
    );
    for (const candidate of chunk) {
      const summary = summaries.get(candidate.key.id);
      const row = selectedAccounts.get(candidate)!;
      if (
        summary &&
        summary.id === row.id &&
        summary.handle === row.handle &&
        summary.displayName === row.displayName &&
        summary.accountKind === row.accountKind
      )
        passed.set(candidate, { key: candidate.key, summary: { kind: 'account', value: summary } });
    }
  }
  return passed;
}
