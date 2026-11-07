import canonicalize from 'canonicalize';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { DiscoveryFilterDocument, FilterDocument, SpoilerThreshold } from '@rezics/filter';
import { matchInverseRelationFacets, type CurrentRelationRelease } from './character-person.ts';
import { anyCurrentMatch, compileCurrentFilter, currentClauseKey } from './current-filter-plan.ts';
import {
  CONCEPT_STATEMENT_PREFIX_LIMITS,
  matchNativeConceptFilter,
  type ConceptFilterExecution,
  type ConceptStatementCut,
  type ConceptStatementReader,
  type ConceptStatementRequest,
} from './concept-browse-statements.ts';
import {
  startConceptBrowse,
  type ConceptDescendantSelection,
  type ConceptBrowseSource,
  type ConceptBrowseStore,
} from './concept-browse.ts';
import { holdsCurrentStatements, holdsCurrentType } from './current-leaf.ts';
import { RequestSourceLifetime } from './request-source-lifetime.ts';
import { REQUEST_SOURCE_KEYS, validateRequestSourceSnapshot } from './request-source-snapshot.ts';
import {
  MAX_RELATION_FACET_PROBES,
  subjectPartition,
  type IndexedSubject,
  type RelationFacetMatch,
  type RelationFacetProbe,
  type SubjectSource,
  type RetainedRelationFacetPage,
} from './source.ts';
import { publicNames } from './document-names.ts';
import { CJK_ANALYZER, NAME_PREFIX_ANALYZER, type EngineToken } from './engine-analysis.ts';
import type { TextNode } from './text.ts';
import type { Hit, FactClause } from './disclosure/check.ts';
import type { CurrentTextAnalysis, CurrentTextAnalyzer as Analyzer } from './disclosure/current-text.ts';
import type { OwnerCurrentAccepted } from './disclosure/owner-current.ts';
import type {
  DiscoveryOwnerKind,
  DiscoveryOwnerMetadataSummary,
  DiscoveryOwnerRegistry,
  DiscoveryReadContext,
  DiscoveryPage,
} from './discovery.ts';
import type { PublicFilterCoveragePage } from './public-filter-coverage-page.ts';
import { OwnerCurrentRestartRequired } from './discovery-errors.ts';
import { SearchOperationError } from './operation-outcomes.ts';
import { SearchUnavailableError } from './opensearch.ts';
import { discoveryCandidateScanBound } from './service-request.ts';

export type { Hit, FactClause } from './disclosure/check.ts';

/** Request-scoped analysis is supplied by the installed native adapter, never by HTTP. */
export type SearchDisclosurePorts = Readonly<{
  analyze(index: string, analyzer: Analyzer, text: string): Promise<readonly EngineToken[]>;
}>;

/** Native hierarchy/storage costs retain the existing admitted reservation dimensions. */
export type ConceptDiscoveryPorts = Readonly<{
  browse(
    selection: ConceptDescendantSelection,
    binding: { principal: string; request: string },
    reserve: (cost: {
      keys: number;
      rows: number;
      points: number;
      statements: number;
      bytes: number;
      emptySeeks: number;
    }) => void,
  ): ConceptBrowseSource;
  store(
    id: string,
    options: { expiresAt: number; reserve: (cost: { statements: number; rows: number; bytes: number }) => void },
  ): ConceptBrowseStore;
  readStatements: ConceptStatementReader;
}>;

/** Finite request work is owned here; physical analyzer and native persistence are adapters. */
export function createSearchDisclosureApplication(ports: SearchDisclosurePorts) {
  return {
    checkHits,
    revalidateOwnerCurrentSummaries,
    finishDiscoveryDisclosure,
    prepareConceptFilter: prepareConceptDisclosure,
    currentText: (index: string) => createCurrentTextMatcher((analyzer, text) => ports.analyze(index, analyzer, text)),
  };
}
export type SearchDisclosureApplication = ReturnType<typeof createSearchDisclosureApplication>;

/** Matches the installed analyzer's finite token concurrency without a foreign initializer. */
export const CURRENT_TEXT_LIMITS = Object.freeze({ scanBytes: 32 * 1024, concurrency: 16 });

const sortedValues = (values: readonly string[]) => [...new Set(values)].sort();

/** Recheck candidates against current anchor snapshots; any failed read rejects the whole page. */
export async function checkHits<NativeHit extends Hit>(
  source: SubjectSource,
  hits: readonly NativeHit[],
  clauses: ReadonlyMap<string, FactClause>,
  options?: {
    concurrency?: number;
    filter?: FilterDocument;
    relationProperties?: readonly string[];
    spoilerThreshold?: SpoilerThreshold;
    observeRelationRelease?: () => Promise<CurrentRelationRelease | null>;
    conceptFilter?: ConceptFilterExecution;
    /** Re-evaluate a stale indexed text hint against the current native Subject projection. */
    currentText?: (subject: IndexedSubject) => Promise<boolean>;
  },
): Promise<{ passed: { hit: NativeHit; subject: IndexedSubject }[]; dropped: number; relationRejected?: true }> {
  const requestedConcurrency = options?.concurrency ?? 8;
  if (!Number.isSafeInteger(requestedConcurrency) || requestedConcurrency < 1)
    throw new RangeError('Concurrency must be a positive safe integer');
  const concurrency = Math.min(requestedConcurrency, 8);

  const plan = options?.filter === undefined ? undefined : compileCurrentFilter(options.filter);
  const hasInverse = [...(plan?.leaves ?? clauses.values())].some(
    (clause) => clause.facet === 'statement' && 'values' in clause && clause.inverse,
  );
  if (hasInverse && (!plan || !options?.observeRelationRelease))
    throw new Error('Inverse disclosure requires the current filter plan and runtime release observer');
  const observeRelease = options?.observeRelationRelease;
  const releaseBefore = observeRelease ? await observeRelease() : undefined;
  if (observeRelease && !releaseBefore) return { passed: [], dropped: hits.length, relationRejected: true };
  const relationProperties = new Set(options?.relationProperties);
  let relationRejected = false;
  let sourceChanged = false;
  const hints = new Map<string, number>();
  if (plan) {
    for (const [name, clause] of clauses) {
      const index = plan.indices.get(currentClauseKey(clause));
      if (index !== undefined) hints.set(name, index);
    }
  }

  const groups = new Map<number, { ids: Set<string>; candidates: { hit: NativeHit; index: number }[] }>();
  for (const [index, hit] of hits.entries()) {
    let partition: number;
    try {
      partition = subjectPartition(hit.id);
    } catch {
      // An untrusted index id without an anchor cannot be disclosed.
      continue;
    }
    if (hit.partition !== partition) continue;
    let group = groups.get(partition);
    if (!group) {
      group = { ids: new Set(), candidates: [] };
      groups.set(partition, group);
    }
    group.ids.add(hit.id);
    group.candidates.push({ hit, index });
  }

  const checked: ({ hit: NativeHit; subject: IndexedSubject } | undefined)[] = new Array(hits.length);
  const partitions = [...groups];
  const lifetime = new RequestSourceLifetime();
  type Point = { probe: RelationFacetProbe; inverse?: true; result?: RelationFacetMatch };
  const pagePoints: Point[] = [];
  const dispatches: (() => Promise<void>)[] = [];
  let dispatchSource = source;
  let next = 0;
  async function worker(): Promise<void> {
    while (!lifetime.stopped) {
      const entry = partitions[next++];
      if (!entry) return;
      const [partition, group] = entry;
      const ids = [...group.ids];
      const subjects = new Map<string, IndexedSubject>();
      const positions = new Map<string, bigint>();
      for (let offset = 0; offset < ids.length; offset += REQUEST_SOURCE_KEYS) {
        if (lifetime.stopped) return;
        const chunk = ids.slice(offset, offset + REQUEST_SOURCE_KEYS);
        const read = await lifetime.start(async () => {
          const snapshot = await source.read(partition, chunk);
          return { position: snapshot.position, subjects: validateRequestSourceSnapshot(snapshot, partition, chunk) };
        });
        if (!read.ok) return;
        for (const id of chunk) positions.set(id, read.value.position);
        for (const [id, subject] of read.value.subjects) subjects.set(id, subject);
      }
      const points = new Map<string, Point>();
      const evaluations = new Map<string, () => Promise<{ passed: boolean; relationRejected: boolean }>>();
      const eligible: { hit: NativeHit; subject: IndexedSubject; index: number }[] = [];
      for (const { hit, index } of group.candidates) {
        const subject = subjects.get(hit.id);
        if (
          !subject ||
          subject.visibility !== 'visible' ||
          subject.redirect !== null ||
          subject.securityRevision !== hit.securityRevision
        )
          continue;
        if (plan) {
          eligible.push({ hit, subject, index });
          if (evaluations.has(subject.id)) continue;
          // Hints determine work order only. Every leaf, including unreported negative leaves,
          // is resolved from current facts before evaluating the original boolean expression.
          const order = new Set<number>();
          for (const name of hit.matched) {
            const leaf = hints.get(name);
            if (leaf !== undefined) order.add(leaf);
          }
          for (const leaf of plan.leaves.keys()) order.add(leaf);
          const values: (RelationFacetMatch | Point[])[] = new Array(plan.leaves.length);
          for (const leaf of order) {
            const clause = plan.leaves[leaf]!;
            if (clause.facet === 'statement' && 'values' in clause && clause.concept) {
              values[leaf] = 'not_proven';
              continue;
            }
            const overflow = clause.facet === 'statement' && subject.relationFacetOverflow?.includes(clause.property);
            const live =
              clause.facet === 'statement' &&
              relationProperties.has(clause.property) &&
              (plan.positive.has(leaf) || !!clause.qualifiers?.length || options?.spoilerThreshold !== undefined);
            const inverse = clause.facet === 'statement' && 'values' in clause && clause.inverse;
            if (clause.facet !== 'statement' || !('values' in clause) || !(overflow || live || inverse)) {
              values[leaf] =
                clause.facet === 'type'
                  ? holdsCurrentType(subject.type, clause)
                  : holdsCurrentStatements(subject.statements, clause);
              continue;
            }
            values[leaf] = sortedValues(clause.values).map((value) => {
              const probe: RelationFacetProbe = {
                subject: subject.id,
                property: clause.property,
                value,
                ...(clause.qualifiers ? { qualifiers: clause.qualifiers } : {}),
                ...(options?.spoilerThreshold === undefined ? {} : { spoilerThreshold: options.spoilerThreshold }),
              };
              const key = JSON.stringify([inverse === true, probe]);
              let point = points.get(key);
              if (!point) {
                point = { probe, ...(inverse ? { inverse: true } : {}) };
                points.set(key, point);
              }
              return point;
            });
          }
          evaluations.set(subject.id, async () => {
            const resolved = values.map((value) =>
              Array.isArray(value) ? anyCurrentMatch(value.map((point) => point.result!)) : value,
            );
            const conceptLeaves = plan.leaves.some(
              (clause) => clause.facet === 'statement' && 'values' in clause && clause.concept,
            );
            if (conceptLeaves) {
              if (!options?.conceptFilter) return { passed: false, relationRejected: true };
              const current = await matchNativeConceptFilter(
                options.conceptFilter.reader,
                partition,
                {
                  subject: subject.id,
                  filter: options.filter!,
                  ...(options.spoilerThreshold === undefined ? {} : { spoilerThreshold: options.spoilerThreshold }),
                },
                options.conceptFilter.resolveCut,
                CONCEPT_STATEMENT_PREFIX_LIMITS,
                ({ leaf }) => {
                  if (leaf.kind !== 'catalogue') return null;
                  const index = plan.indices.get(currentClauseKey(leaf.clause));
                  if (index === undefined) return null;
                  const value = values[index];
                  if (value === undefined) return null;
                  const match = Array.isArray(value)
                    ? anyCurrentMatch(
                        value.map((point) => {
                          if (point.result === undefined) throw new TypeError('Relation evidence was not resolved');
                          return point.result;
                        }),
                      )
                    : value;
                  return {
                    read: async () => ({
                      status: 'current' as const,
                      match,
                      revalidate: async () => 'current' as const,
                    }),
                  };
                },
              );
              if (current.status === 'restart') throw new SearchOperationError('search_restart_required');
              if (current.status !== 'current' || current.match === 'not_proven')
                return { passed: false, relationRejected: true };
              return { passed: current.match === true, relationRejected: false };
            }
            // Bounded uncertainty remains unknown through negation and cannot disclose a hit.
            const passed = plan.evaluate(resolved) === true;
            return {
              passed,
              // Live rejection invalidates the indexed candidate total. Qualified negatives
              // also need this: bounded uncertainty cannot certify final exhaustion.
              relationRejected:
                !passed &&
                values.some((value, leaf) => {
                  const clause = plan.leaves[leaf]!;
                  if (value === 'not_proven') return true;
                  const sensitive =
                    plan.positive.has(leaf) ||
                    (clause.facet === 'statement' &&
                      (!!clause.qualifiers?.length ||
                        options?.spoilerThreshold !== undefined ||
                        ('values' in clause && clause.inverse === true)));
                  return Array.isArray(value) && sensitive;
                }),
            };
          });
          continue;
        }
        if (
          !hit.matched.every((name) => {
            const clause = clauses.get(name);
            return (
              clause === undefined ||
              (clause.facet === 'type'
                ? holdsCurrentType(subject.type, clause)
                : holdsCurrentStatements(subject.statements, clause) === true)
            );
          })
        )
          continue;
        if (!options?.currentText || (await options.currentText(subject))) checked[index] = { hit, subject };
      }
      const pending = [...points.values()];
      pagePoints.push(...pending);
      dispatches.push(async () => {
        for (const inverse of [false, true]) {
          const selected = pending.filter((point) => !!point.inverse === inverse);
          for (let offset = 0; offset < selected.length; offset += MAX_RELATION_FACET_PROBES) {
            if (lifetime.stopped) return;
            const batch = selected.slice(offset, offset + MAX_RELATION_FACET_PROBES);
            const probe = await lifetime.start(() => {
              if (inverse) {
                if (!options?.observeRelationRelease)
                  throw new Error('Inverse disclosure requires a runtime release observer');
                return matchInverseRelationFacets(
                  dispatchSource,
                  partition,
                  batch.map(({ probe }) => ({
                    subject: probe.subject,
                    source: probe.value,
                    property: probe.property,
                    ...(probe.qualifiers ? { qualifiers: probe.qualifiers } : {}),
                    ...(probe.spoilerThreshold === undefined ? {} : { spoilerThreshold: probe.spoilerThreshold }),
                  })),
                  options.observeRelationRelease,
                );
              }
              if (!dispatchSource.matchRelationFacets)
                throw new Error('Relation disclosure requires relation facet probes');
              return dispatchSource.matchRelationFacets(
                partition,
                batch.map((point) => point.probe),
              );
            });
            if (!probe.ok) return;
            const results = probe.value;
            if (!Array.isArray(results) || results.length !== batch.length)
              throw new Error('Malformed relation facet probe results');
            for (const [index, point] of batch.entries()) {
              const result = results[index];
              if (!Object.hasOwn(results, index) || (result !== true && result !== false && result !== 'not_proven'))
                throw new Error('Malformed relation facet probe results');
              point.result = result;
            }
          }
        }
        const outcomes = new Map<string, { passed: boolean; relationRejected: boolean }>();
        for (const { hit, subject, index } of eligible) {
          outcomes.set(subject.id, await evaluations.get(subject.id)!());
        }
        // Reanchor identity, disclosure and facts after retained concept membership work.
        const retired = new Set<string>();
        if (pagePoints.length || options?.conceptFilter) {
          for (let offset = 0; offset < ids.length; offset += REQUEST_SOURCE_KEYS) {
            const chunk = ids.slice(offset, offset + REQUEST_SOURCE_KEYS);
            const read = await lifetime.start(async () => {
              const snapshot = await source.read(partition, chunk);
              return {
                position: snapshot.position,
                subjects: validateRequestSourceSnapshot(snapshot, partition, chunk),
              };
            });
            if (!read.ok) return;
            for (const id of chunk) {
              const before = subjects.get(id);
              const after = read.value.subjects.get(id);
              if (
                positions.get(id) !== read.value.position ||
                after?.visibility !== before?.visibility ||
                after?.redirect !== before?.redirect ||
                after?.type !== before?.type ||
                after?.securityRevision !== before?.securityRevision ||
                (options?.conceptFilter && JSON.stringify(after?.statements) !== JSON.stringify(before?.statements))
              )
                retired.add(id);
            }
          }
        }
        sourceChanged ||= retired.size > 0;
        for (const { hit, subject, index } of eligible) {
          const result = outcomes.get(subject.id)!;
          if (retired.has(subject.id)) {
            relationRejected = true;
            continue;
          }
          if (result.passed && (!options?.currentText || (await options.currentText(subject))))
            checked[index] = { hit, subject };
          relationRejected ||= result.relationRejected;
        }
      });
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, groups.size) }, async () => {
      try {
        await worker();
      } catch (error) {
        lifetime.fail(error);
      }
    }),
  );
  lifetime.throwIfFailed();
  let retained: RetainedRelationFacetPage | undefined;
  if (source.prepareRelationFacets && pagePoints.length) {
    const forward = pagePoints.map(({ probe, inverse }) =>
      inverse ? { ...probe, subject: probe.value, value: probe.subject } : probe,
    );
    retained = await source.prepareRelationFacets(forward);
    const values = await retained.match();
    if (
      !Array.isArray(values) ||
      values.length !== forward.length ||
      forward.some((_, index) => !Object.hasOwn(values, index)) ||
      values.some((value) => value !== true && value !== false && value !== 'not_proven')
    )
      throw new Error('Malformed relation facet probe results');
    const evidence = new Map(forward.map((probe, index) => [JSON.stringify(probe), values[index]!]));
    dispatchSource = {
      read: source.read.bind(source),
      count: source.count.bind(source),
      async matchRelationFacets(_, probes) {
        return probes.map((probe) => evidence.get(JSON.stringify(probe)) ?? 'not_proven');
      },
    };
  }
  for (const dispatch of dispatches) await dispatch();
  lifetime.throwIfFailed();
  if (sourceChanged || (retained && !(await retained.revalidate())))
    return { passed: [], dropped: hits.length, relationRejected: true };
  if (observeRelease) {
    const releaseAfter = await observeRelease();
    if (releaseAfter?.digest !== releaseBefore!.digest || releaseAfter?.head !== releaseBefore!.head)
      return { passed: [], dropped: hits.length, relationRejected: true };
  }
  const passed = checked.filter((entry) => entry !== undefined);
  return { passed, dropped: hits.length - passed.length, ...(relationRejected ? { relationRejected: true } : {}) };
}

function uniqueValues(subject: IndexedSubject, includeDescriptions: boolean): string[] {
  const unique = new Set<string>();
  const values: string[] = [];
  let scanned = 0;
  const add = (language: string, value: string): boolean => {
    const size = Buffer.byteLength(language, 'utf8') + Buffer.byteLength(value, 'utf8');
    if (scanned + size > CURRENT_TEXT_LIMITS.scanBytes) return false;
    scanned += size;
    if (!unique.has(value)) {
      unique.add(value);
      values.push(value);
    }
    return true;
  };
  for (const name of publicNames(subject)) {
    if (!add(name.language, name.value)) return values;
  }
  if (includeDescriptions) {
    for (const name of subject.descriptions) {
      if (!add(name.language, name.value)) return values;
    }
  }
  return values;
}

/** Analyze current native text with the same analyzer installed on the queried Search generation. */
export function createCurrentTextMatcher(analyzeCurrent: CurrentTextAnalysis) {
  const cache = new Map<string, Promise<readonly EngineToken[]>>();
  const waiting: (() => void)[] = [];
  let active = 0;

  async function analyze(analyzer: Analyzer, text: string): Promise<readonly EngineToken[]> {
    const key = `${analyzer}\0${text}`;
    let result = cache.get(key);
    if (!result) {
      result = (async () => {
        if (active >= CURRENT_TEXT_LIMITS.concurrency) await new Promise<void>((resolve) => waiting.push(resolve));
        else active++;
        try {
          return await analyzeCurrent(analyzer, text);
        } finally {
          const next = waiting.shift();
          if (next) next();
          else active--;
        }
      })();
      cache.set(key, result);
      void result.catch(() => cache.delete(key));
    }
    return result;
  }

  async function matchesText(subject: IndexedSubject, query: TextNode): Promise<boolean> {
    const texts = uniqueValues(subject, true);
    const [queryLeaves, currentValues] = await Promise.all([
      (async () => {
        const leaves = new Map<string, readonly EngineToken[]>();
        const visit = async (node: TextNode): Promise<void> => {
          switch (node.kind) {
            case 'term':
            case 'phrase': {
              const key = `${node.kind}\0${node.value}`;
              if (!leaves.has(key)) leaves.set(key, await analyze(CJK_ANALYZER, node.value));
              return;
            }
            case 'not':
              return visit(node.child);
            case 'and':
            case 'or':
              await Promise.all(node.children.map(visit));
          }
        };
        await visit(query);
        return leaves;
      })(),
      Promise.all(texts.map((text) => analyze(CJK_ANALYZER, text))),
    ]);
    const all = new Set(currentValues.flatMap((tokens) => tokens.map(({ token }) => token)));
    const leafMatches = new Map<string, boolean>();
    for (const [key, tokens] of queryLeaves) {
      if (!tokens.length) {
        leafMatches.set(key, false);
        continue;
      }
      if (key.startsWith('term\0')) {
        leafMatches.set(
          key,
          tokens.every(({ token }) => all.has(token)),
        );
        continue;
      }
      const phrase = tokens.map(({ token, position }) => ({ token, offset: position - tokens[0]!.position }));
      const matched = currentValues.some((candidate) => {
        for (const token of candidate) {
          if (token.token !== phrase[0]!.token) continue;
          if (
            phrase.every((part) =>
              candidate.some(
                (current) => current.position === token.position + part.offset && current.token === part.token,
              ),
            )
          )
            return true;
        }
        return false;
      });
      leafMatches.set(key, matched);
    }
    const evaluate = (node: TextNode): boolean => {
      switch (node.kind) {
        case 'term':
        case 'phrase':
          return leafMatches.get(`${node.kind}\0${node.value}`) ?? false;
        case 'not':
          return !evaluate(node.child);
        case 'and':
          return node.children.every(evaluate);
        case 'or':
          return node.children.some(evaluate);
      }
    };
    return evaluate(query);
  }

  async function matchesPrefix(subject: IndexedSubject, prefix: string): Promise<boolean> {
    const query = await analyze(NAME_PREFIX_ANALYZER, prefix);
    if (!query.length) return false;
    const names = uniqueValues(subject, false);
    const candidates = await Promise.all(names.map((name) => analyze(NAME_PREFIX_ANALYZER, name)));
    const exact = new Set(candidates.flatMap((tokens) => tokens.map(({ token }) => token)));
    const final = query.at(-1)!.token;
    return (
      query.slice(0, -1).some(({ token }) => exact.has(token)) ||
      candidates.some((tokens) => tokens.some(({ token }) => token.startsWith(final)))
    );
  }

  return { matchesText, matchesPrefix };
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
  registry: DiscoveryOwnerRegistry,
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
    const adapter = registry.getOwnerAdapter(kind);
    const unique = [...new Set(ids)];
    for (let offset = 0; offset < unique.length; offset += 100) {
      const batch = unique.slice(offset, offset + 100);
      const summaries = await adapter.readCurrent(batch, context);
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

/** Project every dependent value before the one CURRENT native page final.
 * The native root owns the closed plan, complete child chain and own-row sets;
 * returned hits and diagnostic readStatus are not disclosure authority.
 * Kind counts on the projected page must already be decided from this execution:
 * a disclosed sample never becomes an exact total after FINAL.
 */
export async function finishDiscoveryDisclosure(
  coverage: Pick<PublicFilterCoveragePage, 'finish'>,
  project: () => Promise<DiscoveryPage>,
): Promise<DiscoveryPage> {
  const page = await project();
  await coverage.finish();
  return page;
}

type ConceptSelection = Readonly<{ property: string; concept: string; scheme: string }>;

function identity(selection: ConceptSelection): string {
  return JSON.stringify([selection.property, selection.concept, selection.scheme]);
}

function conceptSelections(filter: DiscoveryFilterDocument): ConceptSelection[] {
  const result = new Map<string, ConceptSelection>();
  const pending: DiscoveryFilterDocument[] = [filter];
  while (pending.length) {
    const node = pending.pop()!;
    if ('and' in node || 'or' in node) pending.push(...('and' in node ? node.and : node.or));
    else if ('not' in node) pending.push(node.not);
    else if ('statement' in node && 'in' in node.statement && node.statement.concept) {
      const selection = {
        property: node.statement.property,
        concept: node.statement.in[0]!,
        scheme: node.statement.concept.scheme,
      };
      result.set(identity(selection), selection);
    }
  }
  return [...result.values()];
}

function boundedReservation<T extends Record<string, number>>(maximum: T, name: string) {
  const used = Object.fromEntries(Object.keys(maximum).map((key) => [key, 0])) as Record<keyof T, number>;
  return (cost: T) => {
    for (const key of Object.keys(maximum) as (keyof T)[])
      if ((cost[key] as number) > (maximum[key] as number) - used[key])
        throw new SearchUnavailableError(`${name} exceeded its admitted request reservation`);
    for (const key of Object.keys(maximum) as (keyof T)[]) used[key] += cost[key] as number;
  };
}

function candidateCount(limit: number, countCandidateLimit: number): number {
  return discoveryCandidateScanBound(limit) + countCandidateLimit + 160;
}

function scopeId(selection: ConceptDescendantSelection, binding: ConceptBrowseCut['state']['binding']): string {
  const value = canonicalize({ selection, binding });
  if (value === undefined) throw new TypeError('Concept browse binding is not canonical');
  return createHash('sha256').update(value).digest('hex');
}

type ConceptBrowseCut = ConceptStatementCut;

/**
 * Retain scheme-bound closures in the existing scope-preparation lifecycle before Universal Search
 * evaluates candidates. The same complete cut serves exact and descendant statements; the shared
 * native matcher still decides exactness, qualifiers, Boolean logic and current disclosure.
 */
export async function prepareConceptDisclosure(
  input: Readonly<{
    principal: string;
    request: unknown;
    filter: DiscoveryFilterDocument;
    limit: number;
    countCandidateLimit: number;
    now: () => number;
  }>,
  ports: ConceptDiscoveryPorts,
): Promise<ConceptFilterExecution | undefined> {
  const selections = conceptSelections(input.filter);
  if (!selections.length) return undefined;

  const requestValue = canonicalize({ principal: input.principal, request: input.request });
  if (requestValue === undefined) throw new TypeError('Concept request binding is not canonical');
  const requestBinding = createHash('sha256').update(requestValue).digest('hex');
  const maximumCandidates = candidateCount(input.limit, input.countCandidateLimit);
  const maximumWindows = maximumCandidates * CONCEPT_STATEMENT_PREFIX_LIMITS.windows;
  const maximumRows = maximumCandidates * CONCEPT_STATEMENT_PREFIX_LIMITS.rows;
  // Each matched statement page observes the hierarchy before and after its retained membership
  // probes; the final retained-primary cut check does so once more. Statement reads have their
  // separate replay allowance below.
  const maximumObservations = maximumCandidates * (2 * CONCEPT_STATEMENT_PREFIX_LIMITS.windows + 2) * selections.length;
  const reserveNative = boundedReservation(
    {
      keys: maximumObservations,
      rows: 12 * maximumObservations,
      points: 8 * maximumObservations,
      statements: 12 * maximumObservations,
      bytes: 96_000 * maximumObservations,
      emptySeeks: maximumObservations,
    },
    'Concept hierarchy observation',
  );
  // Each matcher attempt admits at most 32 windows and 2048 raw rows per candidate. The
  // native owner replays every admitted window once for currentness, including hidden rows,
  // rejected rows and an empty terminal seek.
  const reserveStatements = boundedReservation(
    { windows: 2 * maximumWindows, rows: 2 * maximumRows },
    'Concept statement prefix',
  );
  const maximumMemberships = maximumCandidates * (CONCEPT_STATEMENT_PREFIX_LIMITS.rows + selections.length);
  const maximumMembershipReads = maximumCandidates * (CONCEPT_STATEMENT_PREFIX_LIMITS.windows + 1) * selections.length;
  const reserveStorage = boundedReservation(
    {
      statements: 6 * selections.length + maximumMemberships + maximumMembershipReads,
      rows: 4 * selections.length + 2 * (maximumMemberships + maximumMembershipReads),
      bytes: 32_768 * (selections.length + maximumMemberships + maximumMembershipReads),
    },
    'Concept retained membership',
  );

  const cuts = new Map<string, ConceptBrowseCut>();
  for (const selected of selections) {
    const selection: ConceptDescendantSelection = { ...selected, includeChildren: true };
    const browse = ports.browse(selection, { principal: input.principal, request: requestBinding }, reserveNative);
    const observed = await browse.observe();
    if (observed.status !== 'current') {
      if (observed.status === 'preparing') throw new SearchOperationError('index_not_ready');
      if (observed.status === 'unavailable') throw new SearchOperationError('dependency_unavailable');
      throw new SearchOperationError('invalid_request', { errors: [{ pointer: '/filter', code: 'invalid_format' }] });
    }

    const id = scopeId(selection, observed.binding);
    const store = ports.store(id, {
      expiresAt: input.now() + 24 * 60 * 60 * 1000,
      reserve: reserveStorage,
    });
    const state = await startConceptBrowse(selection, observed.binding, store);
    if (!state) throw new SearchUnavailableError('Concept browse definition could not be retained');
    const retained = await store.read(state);
    if (retained.status === 'retired') throw new SearchOperationError('search_restart_required');
    if (retained.status === 'building') throw new SearchOperationError('index_not_ready');
    cuts.set(identity(selected), { source: browse, store, state });
  }

  const reader: ConceptStatementReader = async (partition, request, after, limit) => {
    reserveStatements({ windows: 2, rows: 2 * limit });
    return ports.readStatements(partition, request, after, limit);
  };
  return {
    reader,
    resolveCut(request: ConceptStatementRequest) {
      const key = identity(request.selection);
      return cuts.get(key) ?? null;
    },
  };
}

/** Current-evidence refusal applies to the whole page, including negative predicates. */
export async function runSearchSource<T>(
  operation: () => Promise<T>,
  preserveAdapterError: (error: unknown) => boolean,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof SearchOperationError || preserveAdapterError(error)) throw error;
    if (error instanceof SearchUnavailableError) throw new SearchOperationError('index_not_ready');
    throw new SearchOperationError('semantic_not_ready');
  }
}

/** Each installed service retains one template initialization and retries it after a failed attempt. */
export function createSearchIndexRequest(
  ports: Readonly<{
    install(): Promise<void>;
    unavailable(error: unknown): boolean;
  }>,
) {
  let templates: Promise<void> | undefined;
  return async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      templates ??= ports.install();
      await templates;
      return await operation();
    } catch (error) {
      templates = undefined;
      if (error instanceof SearchUnavailableError || ports.unavailable(error))
        throw new SearchOperationError('index_not_ready');
      throw error;
    }
  };
}
