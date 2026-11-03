import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  completeNativeStatementPrefix,
  conceptStatementRequest,
  conceptStatementQualifiers,
  type ConceptStatementReader,
  type ConceptStatementRead,
} from '../search/concept-browse-statements.ts';
import readConcepts from './search-source-concepts.sql';
import readConceptObservation from './search-source-concept-observation.sql';
import readConceptChildren from './search-source-concept-children.sql';
import type {
  ConceptBrowseBinding,
  ConceptBrowseSource,
  ConceptDescendantSelection,
} from '../search/concept-browse.ts';
import { releaseDigest, type Release } from '@rezics/definitions';
import type { Source } from '@rezics/definitions/bulk';
import {
  createFilterConstruction,
  facetProperties,
  FilterError,
  parseFilter,
  readNativeSpoilerLevel,
  relationFacetProperty,
} from '@rezics/filter';
import type { Pool, PoolClient } from 'pg';
import { readPartition } from '../partition/partition.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { readFences } from '../content/source-fences.ts';
import { withConnection } from '../database/pool.ts';
import {
  MAX_RELATION_FACET_PROBES,
  MAX_RELATION_FACET_VALUES,
  type IndexedStatement,
  type RelationFacetMatch,
  type RelationFacetProbe,
} from '../search/source.ts';
import { activeRelease, readRelease } from './definitions.ts';
import { sourceTuple } from './fences.ts';
import { matchCharacterPersonWitnesses } from '../search/character-person-voice.ts';
import { indexedStatement, inSearchSnapshot } from './search-source.ts';
import readSubjects from './search-source-subjects.sql';
import readBatch from './search-selected-batch.sql';
import readProbeBatch from './search-selected-probe-batch.sql';
import readCursors from './search-selected-cursors.sql';
import writeCursor from './search-selected-progress.sql';
import readReleases from './search-source-releases.sql';
import rebuild from './search-selected-rebuild.sql';

const ZERO = '00000000-0000-0000-0000-000000000000';
const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
export type SelectedStatement = {
  route: number;
  subject_id: string;
  slot_id: string;
  candidate_id: string;
  property: string;
  rank: 'normal' | 'preferred';
  ordinal: number;
  revision: number;
  body: unknown;
  release: string;
  source: unknown;
  relation: boolean;
  eligible: boolean | null;
};

/** Conservative native allowance reserved before each hierarchy observation or seek. */
export type ConceptBrowseNativeReservation = Readonly<{
  keys: number;
  rows: number;
  points: number;
  statements: number;
  bytes: number;
  emptySeeks: number;
}>;
export type ConceptBrowseNativeReserve = (reservation: ConceptBrowseNativeReservation) => void;
type SourceSubject = {
  id: string;
  route: number;
  type: string;
  visibility: string;
  redirect: string | null;
  currentRelease: string | null;
  securityRevision: string;
  current_revision: number | null;
  selection_ready: boolean;
};
type Prepared = {
  partition: number;
  runtime: Awaited<ReturnType<typeof activeRelease>>;
  rows: SelectedStatement[];
  releases: Map<string, Release | null>;
  subjects: { subject: SourceSubject; properties: string[] }[];
};

/** A raw key budget bounds rejects as well as published rows. No permission survives a call. */
export function relationSource(pool: Pool, routeKey?: Uint8Array) {
  /** Independently anchored original and terminal public identities, bounded redirect traversal. */
  async function publicSubjects(
    ids: readonly string[],
    expected: ReadonlyMap<string, SourceSubject>,
    observations?: Map<string, string>,
  ): Promise<Set<string>> {
    const roots = [...new Set(ids)];
    const states = new Map<string, { visible: boolean; redirect: string | null }>();
    let pending = roots;
    for (let depth = 0; pending.length && depth < 8; depth++) {
      const groups = new Map<number, { route: number; id: string }[]>();
      for (const id of pending) {
        if (states.has(id)) continue;
        const route = routeOf(id);
        if (route === null) {
          states.set(id, { visible: false, redirect: null });
          continue;
        }
        const home = partitionOf(route);
        const group = groups.get(home) ?? [];
        group.push({ route, id });
        groups.set(home, group);
      }
      pending = [];
      for (const [partition, group] of groups) {
        const values = await inSearchSnapshot(pool, async (client) => {
          const home = await readPartition(client, partition);
          if (!home || home.writeState === 'moved') return [];
          return readSubjects.run(client, {
            partition_no: partition,
            routes: group.map((x) => x.route),
            subject_ids: group.map((x) => x.id),
          });
        });
        const found = new Map(values.map((row) => [row.id, row]));
        for (const { id } of group) {
          const value = found.get(id);
          observations?.set(`identity:${id}`, JSON.stringify(value ?? null));
          const before = expected.get(id);
          const stable =
            !before ||
            (value?.current_revision === before.current_revision &&
              value?.securityRevision === before.securityRevision &&
              value?.currentRelease === before.currentRelease &&
              value?.type === before.type &&
              value?.selection_ready === before.selection_ready);
          states.set(id, { visible: value?.visibility === 'visible' && stable, redirect: value?.redirect ?? null });
          if (value?.visibility === 'visible' && value.redirect) pending.push(value.redirect);
        }
      }
      pending = [...new Set(pending)];
    }
    const allowed = new Set<string>();
    for (const root of roots) {
      const seen = new Set<string>();
      let id: string | null = root;
      let valid = true;
      while (id) {
        const state = states.get(id);
        if (seen.has(id) || !state?.visible) {
          valid = false;
          break;
        }
        seen.add(id);
        id = state.redirect;
      }
      if (valid) allowed.add(root);
    }
    return allowed;
  }

  async function disclosed(
    rows: readonly SelectedStatement[],
    releases: ReadonlyMap<string, Release | null>,
    expected: ReadonlyMap<string, SourceSubject>,
    runtime: Prepared['runtime'],
    observations?: Map<string, string>,
  ): Promise<{ subject: string; statement: IndexedStatement }[]> {
    if (!routeKey || !runtime) return [];
    const facets = new Map<string, Set<string>>();
    const prepared: {
      row: SelectedStatement;
      statement: IndexedStatement;
      dependencies: string[];
      tuple: ReturnType<typeof sourceTuple> | null;
    }[] = [];
    for (const row of rows) {
      const release = releases.get(row.release);
      const subject = expected.get(row.subject_id);
      const current = runtime.release.properties[row.property];
      if (!subject) continue;
      let admitted = facets.get(subject.type);
      if (!admitted) {
        admitted = new Set(facetProperties(runtime.release, [subject.type]));
        facets.set(subject.type, admitted);
      }
      // The selected row's release explains its stored shape. It cannot grant
      // today's capability after a facet, property or qualifier is retired.
      if (
        !release ||
        !current ||
        row.eligible !== true ||
        !object(row.body) ||
        !admitted.has(row.property) ||
        !relationFacetProperty(runtime.release, row.property) ||
        !relationFacetProperty(release, row.property) ||
        release.properties[row.property]?.datatype !== current.datatype
      )
        continue;
      const statement = indexedStatement(row, release);
      if (!statement) continue;
      const dependencies: string[] = [row.subject_id];
      if (release.properties[row.property]?.datatype === 'wikibase-item') dependencies.push(statement.value);
      let complete = true;
      let spoilerLevel: string | undefined;
      if (Array.isArray(row.body.qualifiers)) {
        for (const qualifier of row.body.qualifiers) {
          // Unknown or withheld qualifiers cannot become an apparently unqualified statement.
          if (
            !object(qualifier) ||
            typeof qualifier.property !== 'string' ||
            !object(qualifier.value) ||
            qualifier.value.type !== 'value'
          ) {
            complete = false;
            break;
          }
          const datatype = release.properties[qualifier.property]?.datatype;
          if (
            !release.properties[row.property]?.qualifiers?.includes(qualifier.property) ||
            !current.qualifiers?.includes(qualifier.property) ||
            runtime.release.properties[qualifier.property]?.datatype !== datatype
          ) {
            complete = false;
            break;
          }
          if (datatype === 'quantity' && qualifier.property === 'rezics:spoilerLevel') {
            // Scalar spoiler evidence has no foreign identity, but must be declared
            // on this exact relation and preserve an exact dimensionless quantity.
            if (
              !release.properties[qualifier.property]?.units?.includes('1') ||
              !runtime.release.properties[qualifier.property]?.units?.includes('1')
            ) {
              complete = false;
              break;
            }
            const level = readNativeSpoilerLevel(qualifier.value.content);
            if (level === null || (spoilerLevel !== undefined && spoilerLevel !== level)) {
              complete = false;
              break;
            }
            spoilerLevel = level;
            continue;
          }
          if (datatype !== 'wikibase-item' && datatype !== 'string') {
            // IndexedStatement cannot represent this qualifier. Omitting it would turn
            // an incomplete association into apparently complete negative evidence.
            complete = false;
            break;
          }
          if (typeof qualifier.value.content !== 'string') {
            complete = false;
            break;
          }
          if (datatype === 'wikibase-item') {
            dependencies.push(qualifier.value.content);
          }
        }
      }
      if (!complete) continue;
      let tuple: ReturnType<typeof sourceTuple> | null = null;
      if (row.source !== null) {
        // Editorial provenance is not an imported tuple. Malformed imported metadata fails closed.
        if (!object(row.source)) continue;
        if (Object.hasOwn(row.source, 'source')) {
          try {
            tuple = sourceTuple(routeKey, row.source as Source);
          } catch {
            continue;
          }
        }
      }
      prepared.push({ row, statement, dependencies, tuple });
    }
    const tuples = new Map<number, ReturnType<typeof sourceTuple>[]>();
    for (const { tuple } of prepared)
      if (tuple) {
        const partition = partitionOf(tuple.route);
        const group = tuples.get(partition) ?? [];
        group.push(tuple);
        tuples.set(partition, group);
      }
    const unfenced = new Set<ReturnType<typeof sourceTuple>>();
    for (const [partition, group] of tuples) {
      for (let offset = 0; offset < group.length; offset += 100) {
        const page = group.slice(offset, offset + 100);
        const fences = await inSearchSnapshot(pool, async (client) => {
          const home = await readPartition(client, partition);
          return !home || home.writeState === 'moved' ? [] : readFences(client, page);
        });
        for (const [index, tuple] of page.entries()) {
          const fence = fences[index];
          observations?.set(`tuple:${JSON.stringify(tuple)}`, JSON.stringify(fence ?? null));
          if (fence?.takenDown === false) unfenced.add(tuple);
        }
      }
    }
    // Source revision/security is reanchored after tuple-owner I/O, together with
    // original and terminal target identities. A changed source stays unknown.
    const visible = await publicSubjects(
      prepared.flatMap((item) => item.dependencies),
      expected,
      observations,
    );
    return prepared
      .filter((item) => item.dependencies.every((id) => visible.has(id)) && (!item.tuple || unfenced.has(item.tuple)))
      .map((item) => ({ subject: item.row.subject_id, statement: item.statement }));
  }

  async function runtimeIsCurrent(runtime: Prepared['runtime']): Promise<boolean> {
    if (!runtime) return false;
    const current = await activeRelease(pool);
    return current?.digest === runtime.digest && current.head === runtime.head;
  }

  /** Full selected-statement prefix, not the value sample used by the indexing path. The
   * returned evidence is private to one attempt and always needs a final native re-read.
   */
  const readConceptStatements: ConceptStatementReader = async (partition, input, after, limit) => {
    const request = conceptStatementRequest(partition, input, after, limit);
    const cursor = after === null ? null : { ...after };
    if (!routeKey) return { status: 'unavailable' };
    const route = routeOf(request.subject)!;
    async function snapshot() {
      return inSearchSnapshot(pool, async (client) => {
        const home = await readPartition(client, partition);
        if (!home || home.writeState === 'moved') return null;
        const runtime = await activeRelease(client);
        if (!runtime) return null;
        const subjects = await readSubjects.run(client, {
          partition_no: partition,
          routes: [route],
          subject_ids: [request.subject],
        });
        const subject = subjects[0];
        if (
          !subject ||
          subject.visibility !== 'visible' ||
          subject.redirect ||
          !subject.selection_ready ||
          subject.current_revision === null
        )
          return null;
        try {
          createFilterConstruction(runtime.release).admitFilter({
            and: [
              { type: { in: [subject.type] } },
              {
                statement: {
                  property: request.selection.property,
                  in: [request.selection.concept],
                  concept: {
                    scheme: request.selection.scheme,
                    ...(request.selection.includeChildren === undefined
                      ? {}
                      : { includeChildren: request.selection.includeChildren }),
                  },
                  qualifiers: conceptStatementQualifiers(request),
                },
              },
            ],
          });
        } catch (error) {
          if (error instanceof FilterError) return null;
          throw error;
        }
        if (!relationFacetProperty(runtime.release, request.selection.property)) return null;
        // The observation binds resumption to the original native subject and release, not to
        // the page size or the returned rows. It supplies no absence or disclosure certificate.
        const observation = createHash('sha256')
          .update(JSON.stringify([runtime.digest, runtime.head, subject]))
          .digest('hex');
        if (cursor && cursor.observation !== observation) return { changed: true } as const;
        const rows = (await readConcepts.run(client, {
          partition_no: partition,
          requests: [
            {
              route,
              subject_id: request.subject,
              property: request.selection.property,
              after_slot: cursor?.slot ?? ZERO,
              after_candidate: cursor?.candidate ?? ZERO,
            },
          ],
          property_limit: limit,
          input_limit: limit,
        })) as SelectedStatement[];
        const releases = new Map<string, Release | null>();
        for (const digest of new Set(rows.map((row) => row.release)))
          releases.set(digest, await readRelease(client, digest));
        return { changed: false, runtime, subject, rows, releases, observation } as const;
      });
    }
    const first = await snapshot();
    if (!first) return { status: 'unavailable' };
    if (first.changed) return { status: 'changed' };
    const identities = new Map<string, string>();
    const expected = new Map([[request.subject, first.subject]]);
    const statements = await disclosed(first.rows, first.releases, expected, first.runtime, identities);
    if (!(await runtimeIsCurrent(first.runtime))) return { status: 'changed' };
    const last = first.rows.at(-1);
    const result: ConceptStatementRead = {
      status: 'current',
      page: {
        statements: statements.map((row) => row.statement),
        examined: first.rows.length,
        after: last ? { slot: last.slot_id, candidate: last.candidate_id, observation: first.observation } : cursor,
        terminal: first.rows.length < limit,
        // selection_ready means this is the full current selected prefix. A short first
        // window therefore proves absence; a full or resumed window only proves progress.
        complete: completeNativeStatementPrefix(first.subject.selection_ready, cursor, first.rows.length, limit),
      },
      async revalidate() {
        const final = await snapshot();
        if (!final) return 'changed';
        if (final.changed || final.observation !== first.observation || !isDeepStrictEqual(first.rows, final.rows))
          return 'changed';
        const currentIdentities = new Map<string, string>();
        const current = await disclosed(
          final.rows,
          final.releases,
          new Map([[request.subject, final.subject]]),
          final.runtime,
          currentIdentities,
        );
        if (
          !isDeepStrictEqual(identities, currentIdentities) ||
          !isDeepStrictEqual(statements, current) ||
          !(await runtimeIsCurrent(final.runtime))
        )
          return 'changed';
        return 'current';
      },
    };
    return result;
  };

  const source = {
    readConceptStatements,
    async prepare(
      client: PoolClient,
      subjects: readonly SourceSubject[],
      releases: ReadonlyMap<string, Release>,
      partition: number,
    ): Promise<Prepared> {
      const runtime = await activeRelease(client);
      const prepared: Prepared = { partition, runtime, rows: [], releases: new Map(releases), subjects: [] };
      const requests: { route: number; subject_id: string; property: string }[] = [];
      for (const subject of subjects) {
        const release = runtime?.release;
        const properties = release
          ? facetProperties(release, [subject.type]).filter((p) => relationFacetProperty(release, p))
          : [];
        prepared.subjects.push({ subject, properties });
        if (!routeKey || !subject.selection_ready || subject.visibility !== 'visible' || subject.redirect) continue;
        for (const property of properties)
          if (requests.length < 1000) requests.push({ route: subject.route, subject_id: subject.id, property });
      }
      if (requests.length) {
        prepared.rows = (await readBatch.run(client, {
          partition_no: partition,
          requests,
          property_limit: MAX_RELATION_FACET_VALUES,
          input_limit: 1000,
        })) as SelectedStatement[];
        for (const row of prepared.rows)
          if (!prepared.releases.has(row.release))
            prepared.releases.set(row.release, await readRelease(client, row.release));
      }
      return prepared;
    },

    async finish(prepared: Prepared): Promise<Map<string, { statements: IndexedStatement[]; overflow: string[] }>> {
      const results = new Map(
        prepared.subjects.map(({ subject, properties }) => [
          subject.id,
          { statements: [] as IndexedStatement[], overflow: properties },
        ]),
      );
      const pending = prepared.subjects.find(({ subject }) => !subject.selection_ready);
      if (pending) await rebuild.run(pool, { route: pending.subject.route, subject_id: pending.subject.id });
      if (!prepared.rows.length) return results;
      const expected = new Map(prepared.subjects.map(({ subject }) => [subject.id, subject]));
      const disclosedStatements = await disclosed(prepared.rows, prepared.releases, expected, prepared.runtime);
      if (!(await runtimeIsCurrent(prepared.runtime))) return results;
      for (const { subject, statement } of disclosedStatements) results.get(subject)!.statements.push(statement);
      return results;
    },

    async match(partition: number, probes: readonly RelationFacetProbe[]): Promise<RelationFacetMatch[]> {
      if (
        !Number.isInteger(partition) ||
        partition < 0 ||
        partition >= 4096 ||
        !Array.isArray(probes) ||
        probes.length > MAX_RELATION_FACET_PROBES
      )
        throw new TypeError('Invalid relation probe page');
      for (const probe of probes) {
        const route = routeOf(probe?.subject);
        if (
          !probe ||
          Object.keys(probe).some(
            (key) => !['subject', 'property', 'value', 'qualifiers', 'spoilerThreshold'].includes(key),
          ) ||
          (probe.spoilerThreshold !== undefined && ![0, 1, 2].includes(probe.spoilerThreshold)) ||
          route === null ||
          partitionOf(route) !== partition ||
          typeof probe.property !== 'string' ||
          typeof probe.value !== 'string'
        )
          throw new TypeError('Invalid relation probe');
        if (probe.qualifiers !== undefined) {
          // Parse only the extension: historical unqualified source callers retain their grammar.
          try {
            parseFilter({ statement: { property: probe.property, in: [probe.value], qualifiers: probe.qualifiers } });
          } catch (error) {
            if (error instanceof FilterError) throw new TypeError('Invalid relation probe');
            throw error;
          }
        }
      }
      if (!probes.length) return [];
      const nativeKey = (p: RelationFacetProbe) => JSON.stringify([p.subject, p.property, p.value]);
      const keyOf = (p: RelationFacetProbe) => JSON.stringify([nativeKey(p), p.qualifiers ?? [], p.spoilerThreshold]);
      const unique = [...new Map(probes.map((p) => [keyOf(p), p])).values()];
      const admitted = new Map<string, RelationFacetProbe[]>();
      const constructions = new Map<Release, ReturnType<typeof createFilterConstruction>>();
      const results = new Map<string, RelationFacetMatch>();
      const snapshot = await inSearchSnapshot(pool, async (client) => {
        const home = await readPartition(client, partition);
        if (!home || home.writeState === 'moved') return null;
        const runtime = await activeRelease(client);
        if (!runtime) return null;
        const local = await readSubjects.run(client, {
          partition_no: partition,
          routes: unique.map((p) => routeOf(p.subject)!),
          subject_ids: unique.map((p) => p.subject),
        });
        const subjects = new Map(local.map((row) => [row.id, row]));
        const releases = new Map<string, Release | null>();
        const digests = [...new Set(local.flatMap((row) => (row.currentRelease ? [row.currentRelease] : [])))];
        if (digests.length)
          for (const row of await readReleases.run(client, { route: 0, digests })) {
            const body = row.body as Release;
            if (releaseDigest(body) === row.digest) releases.set(row.digest, body);
          }
        const requests: { route: number; subject_id: string; property: string; value: string; revision: number }[] = [];
        for (const probe of unique) {
          const subject = subjects.get(probe.subject);
          if (!subject || subject.visibility !== 'visible' || subject.redirect) {
            results.set(keyOf(probe), false);
            continue;
          }
          const release = runtime.release;
          if (
            !subject ||
            !routeKey ||
            !subject.selection_ready ||
            !release ||
            subject.current_revision === null ||
            !facetProperties(release, [subject.type]).includes(probe.property) ||
            !relationFacetProperty(release, probe.property)
          ) {
            results.set(keyOf(probe), 'not_proven');
            continue;
          }
          if (probe.qualifiers !== undefined) {
            try {
              let construction = constructions.get(release);
              if (!construction) {
                construction = createFilterConstruction(release);
                constructions.set(release, construction);
              }
              construction.admitFilter({
                and: [
                  { type: { in: [subject.type] } },
                  { statement: { property: probe.property, in: [probe.value], qualifiers: probe.qualifiers } },
                ],
              });
            } catch (error) {
              if (!(error instanceof FilterError)) throw error;
              results.set(keyOf(probe), 'not_proven');
              continue;
            }
          }
          const key = nativeKey(probe);
          const alternatives = admitted.get(key);
          if (alternatives) {
            alternatives.push(probe);
            continue;
          }
          admitted.set(key, [probe]);
          requests.push({
            route: subject.route,
            subject_id: subject.id,
            property: probe.property,
            value: probe.value,
            revision: subject.current_revision,
          });
        }
        const cursors = requests.length
          ? (await readCursors.run(client, { requests })).flatMap((cursor) => {
              if (
                cursor.route === null ||
                cursor.subject_id === null ||
                cursor.property === null ||
                cursor.value === null ||
                cursor.revision === null
              )
                return [];
              return [
                {
                  route: cursor.route,
                  subject_id: cursor.subject_id,
                  property: cursor.property,
                  value: cursor.value,
                  revision: cursor.revision,
                  after_slot: cursor.after_slot,
                  after_candidate: cursor.after_candidate,
                },
              ];
            })
          : [];
        const rows = cursors.length
          ? ((await readProbeBatch.run(client, {
              partition_no: partition,
              requests: cursors,
              property_limit: Math.min(MAX_RELATION_FACET_VALUES, Math.max(1, Math.floor(1000 / cursors.length))),
              input_limit: 1000,
            })) as SelectedStatement[])
          : [];
        const missing = [...new Set(rows.map((row) => row.release).filter((digest) => !releases.has(digest)))];
        if (missing.length)
          for (const row of await readReleases.run(client, { route: 0, digests: missing })) {
            const body = row.body as Release;
            if (releaseDigest(body) === row.digest) releases.set(row.digest, body);
          }
        return {
          runtime,
          subjects,
          releases,
          cursors,
          rows,
          pending: local.find((subject) => !subject.selection_ready),
        };
      });
      if (!snapshot) return probes.map(() => 'not_proven');
      const { runtime, subjects, releases, cursors, rows, pending } = snapshot;
      if (pending) await rebuild.run(pool, { route: pending.route, subject_id: pending.id });
      const disclosedStatements = await disclosed(rows, releases, subjects, runtime);
      const admittedProbes = [...admitted.values()].flat();
      const witnesses = await matchCharacterPersonWitnesses(
        admittedProbes,
        disclosedStatements,
        (appearances, appearancePartition) => source.match(appearancePartition, appearances),
        () => disclosed(rows, releases, subjects, runtime),
      );
      for (const [index, probe] of admittedProbes.entries())
        if (witnesses[index] === true) results.set(keyOf(probe), true);
      const progress: {
        route: number;
        subject_id: string;
        property: string;
        value: string;
        revision: number;
        after_slot: string;
        after_candidate: string;
        previous_slot: string;
        previous_candidate: string;
      }[] = [];
      for (const cursor of cursors) {
        const probe = { subject: cursor.subject_id, property: cursor.property, value: cursor.value };
        if (admitted.get(nativeKey(probe))?.every((entry) => results.get(keyOf(entry)) === true)) continue;
        const consumed = rows.filter(
          (row) =>
            row.subject_id === cursor.subject_id &&
            row.property === cursor.property &&
            object(row.body) &&
            object(row.body.value) &&
            row.body.value.content === cursor.value,
        );
        const last = consumed.at(-1);
        // A foreign restoration may occur without changing the source revision. At EOF the next
        // sweep begins at zero; no rejected work is ever interpreted as an absence certificate.
        if (last || cursor.after_slot !== ZERO || cursor.after_candidate !== ZERO)
          progress.push({
            route: cursor.route,
            subject_id: cursor.subject_id,
            property: cursor.property,
            value: cursor.value,
            revision: cursor.revision,
            after_slot: last?.slot_id ?? ZERO,
            after_candidate: last?.candidate_id ?? ZERO,
            previous_slot: cursor.after_slot,
            previous_candidate: cursor.after_candidate,
          });
      }
      if (progress.length) await withConnection(pool, (client) => writeCursor.run(client, { progress }));
      if (!(await runtimeIsCurrent(runtime))) return probes.map(() => 'not_proven');
      return probes.map((p) => results.get(keyOf(p)) ?? 'not_proven');
    },
  };
  function conceptBrowse(
    selection: ConceptDescendantSelection,
    identity: Pick<ConceptBrowseBinding, 'principal' | 'request'>,
    reserve?: ConceptBrowseNativeReserve,
  ): ConceptBrowseSource {
    const route = routeOf(selection.concept);
    const schemeRoute = routeOf(selection.scheme);
    if (
      route === null ||
      schemeRoute === null ||
      selection.includeChildren !== true ||
      typeof selection.property !== 'string' ||
      !selection.property ||
      typeof identity.principal !== 'string' ||
      !identity.principal ||
      typeof identity.request !== 'string' ||
      !identity.request
    )
      throw new TypeError('Invalid concept browse definition');

    const allowance = (cost: ConceptBrowseNativeReservation) => reserve?.(cost);
    async function snapshot() {
      return inSearchSnapshot(pool, async (client) => {
        const home = await readPartition(client, partitionOf(route));
        const schemeHome =
          partitionOf(route) === partitionOf(schemeRoute)
            ? home
            : await readPartition(client, partitionOf(schemeRoute));
        if (!home || !schemeHome || home.writeState === 'moved' || schemeHome.writeState === 'moved') return null;
        const runtime = await activeRelease(client);
        if (!runtime) return null;
        const [row] = await readConceptObservation.run(client, {
          concept: selection.concept,
          scheme: selection.scheme,
          route,
        });
        if (!row) return null;
        const graph = await client.query<{ last_value: string; is_called: boolean }>(
          `SELECT last_value::text,is_called FROM semantic.search_canonical_generation`,
        );
        const generation = graph.rows[0];
        if (!generation || !/^[0-9]+$/.test(generation.last_value)) return null;
        return {
          runtime,
          graph: `${generation.last_value}:${generation.is_called ? 1 : 0}`,
          conceptType: row.concept_type,
          conceptVisibility: row.concept_visibility,
          conceptSecurityRevision: row.concept_security_revision,
          conceptRelease: row.concept_release,
          conceptReady: row.concept_ready,
          schemeType: row.scheme_type,
          schemeVisibility: row.scheme_visibility,
          schemeReady: row.scheme_ready,
          member: row.member,
        };
      });
    }
    const bind = (value: NonNullable<Awaited<ReturnType<typeof snapshot>>>): ConceptBrowseBinding => ({
      release: `${value.runtime.digest}:${value.runtime.head ?? 0}`,
      graph: value.graph,
      scheme: selection.scheme,
      membership: createHash('sha256')
        .update(
          JSON.stringify([
            selection.concept,
            selection.scheme,
            value.conceptSecurityRevision,
            value.conceptRelease,
            value.graph,
            value.member,
          ]),
        )
        .digest('hex'),
      principal: identity.principal,
      request: identity.request,
    });
    const same = (left: ConceptBrowseBinding, right: ConceptBrowseBinding) =>
      left.release === right.release &&
      left.graph === right.graph &&
      left.scheme === right.scheme &&
      left.membership === right.membership &&
      left.principal === right.principal &&
      left.request === right.request;
    const expected = (value: NonNullable<Awaited<ReturnType<typeof snapshot>>>) =>
      value.conceptType === 'skos:Concept' &&
      value.conceptVisibility === 'visible' &&
      value.schemeType === 'skos:ConceptScheme' &&
      value.schemeVisibility === 'visible';

    return {
      async observe() {
        allowance({ keys: 1, rows: 12, points: 8, statements: 12, bytes: 96_000, emptySeeks: 1 });
        const first = await snapshot();
        if (!first) return { status: 'unavailable' as const };
        if (!first.conceptReady || !first.schemeReady) return { status: 'preparing' as const };
        if (!expected(first) || !first.member) return { status: 'rejected' as const };
        const rootMember = await source.match(partitionOf(route), [
          { subject: selection.concept, property: 'skos:inScheme', value: selection.scheme },
        ]);
        if (rootMember[0] !== true)
          return { status: rootMember[0] === false ? ('rejected' as const) : ('unavailable' as const) };
        const final = await snapshot();
        if (!final) return { status: 'unavailable' as const };
        if (!final.conceptReady || !final.schemeReady) return { status: 'preparing' as const };
        if (!expected(final) || !final.member) return { status: 'rejected' as const };
        const binding = bind(final);
        return same(bind(first), binding) ? { status: 'current' as const, binding } : { status: 'preparing' as const };
      },
      async children(input) {
        const { parent, after, binding, limit } = input;
        const cursor = after === null ? null : /^(\d{5}):([0-9a-f-]{36}):([0-9a-f-]{36}):([0-9a-f-]{36})$/.exec(after);
        const cursorRoute = cursor ? Number(cursor[1]) : null;
        if (
          routeOf(parent) === null ||
          !Number.isSafeInteger(limit) ||
          limit < 1 ||
          limit > 64 ||
          (after !== null &&
            (!cursor ||
              !Number.isSafeInteger(cursorRoute) ||
              cursorRoute! > 65535 ||
              routeOf(cursor[2]) !== cursorRoute ||
              !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(cursor[3]!) ||
              !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(cursor[4]!)))
        )
          return { status: 'rejected' as const };
        allowance({
          keys: limit,
          rows: limit * 4,
          points: limit * 2 + 2,
          statements: 8 + limit * 4,
          bytes: 16_384 + limit * 4_096,
          emptySeeks: 1,
        });
        const page = await inSearchSnapshot(pool, async (client) => {
          const current = await activeRelease(client);
          if (!current) return null;
          const graph = await client.query<{ last_value: string; is_called: boolean }>(
            `SELECT last_value::text,is_called FROM semantic.search_canonical_generation`,
          );
          const generation = graph.rows[0];
          if (!generation || !/^[0-9]+$/.test(generation.last_value)) return null;
          const observation = await readConceptObservation.run(client, {
            concept: selection.concept,
            scheme: selection.scheme,
            route,
          });
          const root = observation[0];
          if (!root) return null;
          const currentBinding = bind({
            runtime: current,
            graph: `${generation.last_value}:${generation.is_called ? 1 : 0}`,
            conceptType: root.concept_type,
            conceptVisibility: root.concept_visibility,
            conceptSecurityRevision: root.concept_security_revision,
            conceptRelease: root.concept_release,
            conceptReady: root.concept_ready,
            schemeType: root.scheme_type,
            schemeVisibility: root.scheme_visibility,
            schemeReady: root.scheme_ready,
            member: root.member,
          });
          const values = cursor
            ? {
                after_route: Number(cursor[1]),
                after_subject: cursor[2],
                after_slot: cursor[3],
                after_candidate: cursor[4],
              }
            : {
                after_route: -1,
                after_subject: '00000000-0000-0000-0000-000000000000',
                after_slot: '00000000-0000-0000-0000-000000000000',
                after_candidate: '00000000-0000-0000-0000-000000000000',
              };
          const rows = await readConceptChildren.run(client, {
            parent,
            scheme: selection.scheme,
            ...values,
            limit,
          });
          return { binding: currentBinding, rows };
        });
        if (!page) return { status: 'unavailable' as const };
        if (!same(page.binding, binding))
          return {
            status: 'current' as const,
            page: { binding: page.binding, children: [], examined: 0, after, hasMore: false },
          };
        const byPartition = new Map<number, typeof page.rows>();
        for (const row of page.rows) {
          const childRoute = routeOf(row.child);
          if (childRoute === null) return { status: 'rejected' as const };
          const partition = partitionOf(childRoute);
          const group = byPartition.get(partition) ?? [];
          group.push(row);
          byPartition.set(partition, group);
        }
        const children: string[] = [];
        for (const [partition, rows] of byPartition) {
          const results = await source.match(
            partition,
            rows.flatMap((row) => [
              { subject: row.child, property: 'skos:broader', value: parent },
              { subject: row.child, property: 'skos:inScheme', value: selection.scheme },
            ]),
          );
          if (results.length !== rows.length * 2 || results.includes('not_proven'))
            return { status: 'unavailable' as const };
          for (const [index, row] of rows.entries())
            if (results[index * 2] === true && results[index * 2 + 1] === true) children.push(row.child);
        }
        const last = page.rows.at(-1);
        const next = last
          ? `${String(last.route).padStart(5, '0')}:${last.child}:${last.slot}:${last.candidate}`
          : after;
        return {
          status: 'current' as const,
          page: {
            binding: page.binding,
            children,
            examined: page.rows.length,
            after: next,
            // A full bounded page continues; the next seek, including an empty terminal seek,
            // proves whether another edge exists.
            hasMore: page.rows.length === limit,
          },
        };
      },
    };
  }

  return { ...source, conceptBrowse };
}
