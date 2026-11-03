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
import { holdsCurrentStatements } from '../search/current-leaf.ts';
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
        !release || !current || row.eligible !== true || !object(row.body) ||
        !admitted.has(row.property) || !relationFacetProperty(runtime.release, row.property) ||
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
        for (const [index, fence] of fences.entries()) if (fence.takenDown === false) unfenced.add(page[index]!);
      }
    }
    // Source revision/security is reanchored after tuple-owner I/O, together with
    // original and terminal target identities. A changed source stays unknown.
    const visible = await publicSubjects(
      prepared.flatMap((item) => item.dependencies),
      expected,
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

  return {
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
          Object.keys(probe).some((key) => !['subject', 'property', 'value', 'qualifiers'].includes(key)) ||
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
      const keyOf = (p: RelationFacetProbe) => JSON.stringify([nativeKey(p), p.qualifiers ?? []]);
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
        return { runtime, subjects, releases, cursors, rows, pending: local.find((subject) => !subject.selection_ready) };
      });
      if (!snapshot) return probes.map(() => 'not_proven');
      const { runtime, subjects, releases, cursors, rows, pending } = snapshot;
      if (pending) await rebuild.run(pool, { route: pending.route, subject_id: pending.id });
      const disclosedStatements = await disclosed(rows, releases, subjects, runtime);
      for (const { subject, statement } of disclosedStatements) {
        const key = nativeKey({ subject, property: statement.property, value: statement.value });
        for (const probe of admitted.get(key) ?? []) {
          if (
            holdsCurrentStatements([statement], {
              facet: 'statement',
              property: probe.property,
              values: [probe.value],
              ...(probe.qualifiers ? { qualifiers: probe.qualifiers } : {}),
            })
          )
            results.set(keyOf(probe), true);
        }
      }
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
}
