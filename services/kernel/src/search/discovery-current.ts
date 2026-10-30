import { relationFacetProperty, type DiscoveryFilterDocument, type FilterRelease } from '@rezics/filter';
import { partitionOf, routeOf } from '../route/route.ts';
import type {
  DiscoveryHit,
  DiscoveryReadContext,
  DiscoveryRegistry,
  IndexedAccount,
  DiscoveryEngineHit,
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
  for (const [partition, group] of partitioned(accounts.map(({ key }) => key))) {
    const ids = [...new Set(group.map(({ id }) => id))];
    const current = new Map<string, IndexedAccount>();
    for (let offset = 0; offset < ids.length; offset += 100) {
      const chunk = ids.slice(offset, offset + 100);
      const snapshot = await entry.source.read(partition, chunk);
      if (
        snapshot.partition !== partition ||
        typeof snapshot.position !== 'bigint' ||
        snapshot.position < 0n ||
        !Array.isArray(snapshot.accounts) ||
        snapshot.accounts.length > chunk.length
      )
        unavailable();
      if (
        accounts.some(
          (candidate) =>
            chunk.includes(candidate.key.id) &&
            'sourcePosition' in candidate &&
            BigInt(candidate.sourcePosition) > snapshot.position,
        )
      )
        unavailable();
      for (const account of snapshot.accounts) {
        if (
          !chunk.includes(account.id) ||
          current.has(account.id) ||
          typeof account.revision !== 'bigint' ||
          account.revision < 0n ||
          (account.accountKind !== 'actor' && account.accountKind !== 'organization') ||
          (account.handle !== null && typeof account.handle !== 'string') ||
          (account.displayName !== null && typeof account.displayName !== 'string')
        )
          unavailable();
        current.set(account.id, account);
      }
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
  for (let offset = 0; offset < selected.length; offset += 100) {
    const chunk = selected.slice(offset, offset + 100);
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
