import { relationFacetProperty, type DiscoveryFilterDocument, type FilterRelease } from '@rezics/filter';
import { partitionOf, routeOf } from '../route/route.ts';
import { validateAccountSnapshot } from './account-discovery.ts';
import {
  MAX_ACCOUNT_DISCOVERY_BATCH,
  type DiscoveryHit,
  type DiscoveryReadContext,
  type DiscoveryRegistry,
  type DiscoveryOwnerRegistry,
  type DiscoveryOwnerKey,
  type IndexedAccount,
  type DiscoveryEngineHit,
  type DiscoveryKey,
  type DiscoveryUnionKey,
  type DiscoveryUnionHit,
  type DiscoveryRegistration,
  type AccountSnapshot,
} from './discovery.ts';
import type { DiscoveryCandidate } from './discovery-query.ts';
import { hydrateOwnerDiscoveryHits, type DiscoveryOwnerCandidate } from './discovery-hydration.ts';
import { currentDiscoveryFilter } from './discovery-filter.ts';
import { checkHits } from './disclosure/check.ts';
import { SearchUnavailableError } from './opensearch.ts';
import { validateRequestSourceSnapshot } from './request-source-snapshot.ts';
import { admitDiscoveryHit } from './discovery-http.ts';
import type { IndexedSubject, SubjectSnapshot, SubjectSource } from './source.ts';
import { projectCharacterPersonContexts } from './character-person.ts';
import { chooseTexts } from './hits.ts';
import { ProblemError } from '../http/problem.ts';

function unavailable(): never {
  throw new SearchUnavailableError('Current discovery owner evidence is unavailable or malformed');
}
function requireCurrentOwner(
  registry: DiscoveryRegistry & Partial<DiscoveryOwnerRegistry>,
  key: DiscoveryUnionKey,
): void {
  if (key.owner === 'semantic' || key.owner === 'accounts') {
    const owner = String(registry.get(key.kind).owner);
    if (owner !== String(key.owner)) unavailable();
    registry.key(key);
    return;
  }
  const slot = registry.ownerAdapters?.[key.kind];
  if (
    !slot ||
    slot.readiness !== 'ready' ||
    slot.adapter.owner !== key.owner ||
    slot.adapter.kind !== key.kind ||
    !registry.ownerKey
  )
    unavailable();
  registry.ownerKey(key as DiscoveryOwnerKey);
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

/** A missing summary after positive current evidence is unavailable, not an excluded candidate. */
async function completeSummaries<T>(
  ids: readonly string[],
  hydrate: (ids: readonly string[]) => Promise<ReadonlyMap<string, T>>,
): Promise<Map<string, T>> {
  const unique = [...new Set(ids)];
  const current = new Map<string, T>();
  for (let offset = 0; offset < unique.length; offset += 100) {
    const chunk = unique.slice(offset, offset + 100);
    const requested = new Set(chunk);
    const observed = await hydrate(chunk);
    if (!observed || typeof observed[Symbol.iterator] !== 'function') unavailable();
    for (const [id, summary] of observed) {
      if (!requested.delete(id) || summary == null) unavailable();
      // Do not retain mutable owner objects across subsequent reads or final publication.
      current.set(id, structuredClone(summary));
    }
    if (requested.size) unavailable();
  }
  return current;
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
  registry: DiscoveryRegistry & Partial<DiscoveryOwnerRegistry>,
  candidates: readonly Candidate[],
  filter: DiscoveryFilterDocument | undefined,
  release: FilterRelease,
  context: DiscoveryReadContext,
): Promise<Map<Candidate, DiscoveryUnionHit>> {
  if (candidates.length > 200) unavailable();
  const passed = new Map<Candidate, DiscoveryUnionHit>();
  for (const candidate of candidates) {
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
        ...(context.spoilerThreshold === undefined ? {} : { spoilerThreshold: context.spoilerThreshold }),
        ...(context.observeRelationRelease === undefined
          ? {}
          : { observeRelationRelease: context.observeRelationRelease }),
      });
      const checkedSubjects = new Map(
        checked.passed
          .filter(({ subject }) => subject.type === entry.kind)
          .map(({ subject }) => [subject.id, subject]),
      );
      const accepted = new Set(
        checkedSubjects.keys(),
      );
      selectedSemantic.push(...group.filter(({ key }) => accepted.has(key.id)));
    }
    const semanticEntry = registry.entries.find((entry) => entry.owner === 'semantic');
    if (selectedSemantic.length && semanticEntry) {
      // All catalogue registrations share one native hydrator, independent of selected kind count.
      const summaries = await completeSummaries(
        selectedSemantic.map(({ key }) => key.id),
        (ids) => semanticEntry.hydrate(ids, context),
      );
      for (const candidate of selectedSemantic) {
        const summary = summaries.get(candidate.key.id);
        const subject = checkedSubjects.get(candidate.key.id);
        if (!summary || !subject) continue;
        const labels = Object.fromEntries(
          Object.entries(
            chooseTexts(
              subject.labels,
              context.languages,
              subject.statements.find(({ property }) => property === 'schema:inLanguage')?.value,
            ),
          ).sort(([first], [second]) => first.localeCompare(second)),
        );
        const aliasesByLanguage = new Map<string, Set<string>>();
        for (const alias of subject.aliases) {
          if (context.languages?.length && !context.languages.includes(alias.language)) continue;
          const values = aliasesByLanguage.get(alias.language) ?? new Set<string>();
          values.add(alias.value);
          aliasesByLanguage.set(alias.language, values);
        }
        const aliases = Object.fromEntries(
          [...aliasesByLanguage]
            .sort(([first], [second]) => first.localeCompare(second))
            .map(([language, values]) => [language, [...values].sort()]),
        );
        const selectedLabel = Object.entries(labels)[0];
        const contexts =
          context.observeRelationRelease === undefined
            ? null
            : await projectCharacterPersonContexts(source, subject, filter, {
                ...(context.languages === undefined ? {} : { languages: context.languages }),
                ...(context.spoilerThreshold === undefined ? {} : { spoilerThreshold: context.spoilerThreshold }),
                observeRelationRelease: context.observeRelationRelease,
              });
        if (
          context.observeRelationRelease !== undefined &&
          (subject.type === 'schema:Person' || subject.type === 'schema:Character') &&
          contexts === null
        )
          throw new ProblemError('search_restart_required');
        const hit = {
          key: candidate.key,
          summary: {
            kind: 'subject' as const,
            value: { ...summary, label: selectedLabel ? { language: selectedLabel[0], value: selectedLabel[1] } : null },
          },
          labels,
          ...(Object.keys(aliases).length ? { aliases } : {}),
          ...(contexts === null ? {} : { contexts }),
        };
        admitDiscoveryHit(hit);
        passed.set(candidate, hit);
      }
      // Hydration and context disclosure can cross native I/O. Retire the whole semantic window
      // if its candidate anchors changed after the first current-source snapshot.
      for (const [partition, group] of partitioned(selectedSemantic.map(({ key }) => key))) {
        const baseline = snapshots.get(partition);
        const ids = [...new Set(group.map(({ id }) => id))];
        for (let offset = 0; offset < ids.length; offset += 256) {
          const chunk = ids.slice(offset, offset + 256);
          const after = await source.read(partition, chunk);
          const currentRows = validateRequestSourceSnapshot(after, partition, chunk);
          if (!baseline || after.position !== baseline.position) throw new ProblemError('search_restart_required');
          const previousRows = new Map(baseline.subjects.map((subject) => [subject.id, subject]));
          for (const id of chunk) {
            const previous = previousRows.get(id);
            const current = currentRows.get(id);
            if (
              !previous ||
              !current ||
              current.visibility !== 'visible' ||
              current.redirect !== null ||
              current.securityRevision !== previous.securityRevision ||
              current.type !== previous.type
            )
              throw new ProblemError('search_restart_required');
          }
        }
      }
    }
  }
  const accounts = candidates.filter(({ key }) => key.owner === 'accounts');
  if (accounts.length) {
    const entry = registry.get('account');
    if (entry.owner !== 'accounts') unavailable();
    if (!filter || currentDiscoveryFilter(filter, registry, entry.kind, release) === true) {
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
      const summaries = await completeSummaries(
        selected.map(({ key }) => key.id),
        (ids) => entry.hydrate(ids, context),
      );
      for (const candidate of selected) {
        const summary = summaries.get(candidate.key.id);
        const row = selectedAccounts.get(candidate)!;
        const hit = { key: candidate.key as DiscoveryKey, summary: { kind: 'account' as const, value: summary } };
        admitDiscoveryHit(hit);
        if (
          !summary ||
          summary.handle !== row.handle ||
          summary.displayName !== row.displayName ||
          summary.accountKind !== row.accountKind
        )
          unavailable();
        passed.set(candidate, hit);
      }
    }
  }

  const owners = candidates.filter(
    ({ key }) =>
      key.owner === 'commerce' || (key.owner === 'content' && (key.kind === 'review' || key.kind === 'space')),
  );
  const ownerCandidates: DiscoveryOwnerCandidate[] = [];
  const ownerOriginals: Candidate[] = [];
  for (const candidate of owners) {
    const specialized = filter ? currentDiscoveryFilter(filter, registry, candidate.key.kind, release) : true;
    if (specialized !== true) continue;
    const document = 'document' in candidate ? candidate.document : undefined;
    let revision: string | undefined;
    let sourcePosition: string | undefined;
    let sourceVersion: string | null | undefined;
    if ('revision' in candidate) {
      revision = candidate.revision;
      sourcePosition = candidate.sourcePosition;
      sourceVersion = candidate.sourceVersion;
    } else if (document && (document.owner === 'commerce' || document.owner === 'content')) {
      revision = document.revision;
      sourcePosition = document.source_position;
      sourceVersion = document.source_version;
    }
    if (typeof revision !== 'string' || typeof sourcePosition !== 'string') unavailable();
    ownerCandidates.push({
      key: candidate.key as DiscoveryOwnerKey,
      revision,
      sourcePosition,
      ...(sourceVersion === undefined ? {} : { sourceVersion }),
    });
    ownerOriginals.push(candidate);
  }
  if (ownerCandidates.length) {
    if (!registry.ownerAdapters || !registry.ownerKey || !registry.getOwnerAdapter) unavailable();
    const ownerHits = await hydrateOwnerDiscoveryHits(
      registry as DiscoveryRegistry & DiscoveryOwnerRegistry,
      ownerCandidates,
      context,
    );
    for (let index = 0; index < ownerHits.length; index++) {
      const hit = ownerHits[index];
      if (!hit) continue;
      admitDiscoveryHit(hit);
      passed.set(ownerOriginals[index]!, hit);
    }
  }
  return passed;
}
