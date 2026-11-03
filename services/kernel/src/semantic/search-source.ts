import { indexedStatement, selectedCandidate, selectedRank } from './scope-leaf-selection.ts';
export { indexedStatement } from './scope-leaf-selection.ts';
import {
  readSubjectKeyPage,
  createSubjectCanonicalNames,
  type SubjectCanonicalNames,
  type SubjectSourceKeyTraversal as SubjectSourceKeyPages,
} from './subject-source-key-pages.ts';
import type { Release } from '@rezics/definitions';
import { relationSource } from './search-relations.ts';
import { readRelease } from './definitions.ts';
import type { Pool, PoolClient } from 'pg';
import { CommandUnavailableError } from '../access/unavailable.ts';
import { discardConnection, withConnection } from '../database/pool.ts';
import { withoutFencedEntries } from './fences.ts';
import { PARTITIONS, partitionOf, routeOf } from '../route/route.ts';
import type { IndexedStatement, IndexedSubject, SubjectSnapshot, SubjectSource } from '../search/source.ts';
import count from './search-source-count.sql';
import readAdoptions from './search-source-adoptions.sql';
import readFacts from './search-source-facts.sql';
import readReleases from './search-source-releases.sql';
import readPosition from './search-source-position.sql';
import readStatements from './search-source-statements.sql';
import readSubjects from './search-source-subjects.sql';
import { accessCheck } from '../request/access.ts';
import { mintReadTime } from '../command/command.ts';
import { classifyUnavailability, requireAccessDeadline } from '../access/unavailable.ts';
import { readPartition } from '../partition/partition.ts';
import { subjectReadEligibility } from './eligibility.ts';
import { withPublicStatementReader } from './statement-disclosure.ts';
import { withIdentitySourceSupportJob } from './identity-source-support-scope.ts';
import { identityEpochStore } from './identity-epoch-store.ts';
import type { IdentityJobRef } from './identity-epoch-contract.ts';
import type {
  PublicFilterCost,
  PublicFilterProjectionPage,
  PublicFilterProjectionRequest,
  PublicFilterSource,
  PublicFilterSourceFactory,
} from './public-filter-source-contract.ts';
import readVisibility from './read-visibility.sql';
import { withReadTransaction } from './read.ts';
import { withRequestDeadline } from '../request/deadline.ts';

type SubjectRow = {
  selection_ready: boolean;
  current_revision: number | null;
  route: number;
  id: string;
  type: string;
  visibility: IndexedSubject['visibility'];
  securityRevision: string;
  currentRelease: string | null;
  redirect: string | null;
};
type FactRow = {
  entry_kind: 'term' | 'compact' | 'expanded';
  route: number;
  id: string;
  slot_id: string;
  log_seq: number;
  operation: 'assert' | 'retract' | 'expand';
  kind: 'label' | 'description' | 'alias' | 'statement';
  language: string | null;
  property: string | null;
  candidate_id: string | null;
  body: unknown;
  release: string | null;
};
type AdoptionRow = {
  route: number;
  subject_id: string;
  slot_id: string;
  mode: 'inherit' | 'replace' | 'suppress' | null;
  selection: unknown;
};
type StatementEntry = {
  source: 'compact' | 'expanded';
  route: number;
  subject_id: string;
  slot_id: string;
  property: string;
  candidate_id: string;
  rank: 'normal' | 'preferred';
  ordinal: number;
  body?: unknown;
  release?: string;
};
type StatementRow = {
  subject_id: string;
  property: string;
  rank: 'normal' | 'preferred';
  body: unknown;
  release: string;
  ordinal: number;
};

/** Current name/fact/visibility publication fence used by complete Search traversals. */
export async function readSearchCanonicalGeneration(pool: Pool): Promise<string> {
  const result = await pool.query<{ last_value: string; is_called: boolean }>(
    `SELECT last_value::text,is_called FROM semantic.search_canonical_generation`,
  );
  const row = result.rows[0];
  if (!row || !/^[0-9]+$/.test(row.last_value)) throw new Error('Search canonical generation is unavailable');
  return `${row.last_value}:${row.is_called ? 1 : 0}`;
}

const ASCII = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function assertPartition(partition: number): void {
  if (!Number.isInteger(partition) || partition < 0 || partition >= PARTITIONS)
    throw new TypeError('Partition must be an integer from 0 through 4095');
}

function termValues(rows: FactRow[], kind: 'label' | 'description' | 'alias') {
  const current = new Map<string, string>();
  const aliases = new Map<string, string[]>();
  for (const row of rows) {
    if (row.kind !== kind || row.language === null || typeof row.body !== 'string') continue;
    if (kind === 'alias') {
      const values = aliases.get(row.language) ?? [];
      const index = values.indexOf(row.body);
      if (row.operation === 'retract') {
        if (index >= 0) values.splice(index, 1);
      } else if (index < 0) values.push(row.body);
      aliases.set(row.language, values);
    } else if (row.operation === 'retract') current.delete(row.language);
    else current.set(row.language, row.body);
  }
  if (kind === 'alias')
    return [...aliases].flatMap(([language, values]) => values.map((value) => ({ language, value })));
  return [...current].map(([language, value]) => ({ language, value }));
}

export async function inSearchSnapshot<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  return withConnection(pool, async (client) => {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        discardConnection(client, rollbackError as Error);
      }
      throw error;
    }
  });
}

export function subjectSource(pool: Pool, routeKey?: Uint8Array): SubjectSource & SubjectSourceKeyPages & {
  canonicalNames: SubjectCanonicalNames;
} {
  const relations = relationSource(pool, routeKey);
  return {
    readSubjectKeyPage,
    canonicalNames: createSubjectCanonicalNames(pool),
    async read(partition, ids): Promise<SubjectSnapshot> {
      assertPartition(partition);
      if (ids.length > 256) throw new TypeError('A subject snapshot accepts at most 256 ids');
      const requested = new Map<string, number>();
      for (const id of ids) {
        const route = routeOf(id);
        if (route === null || partitionOf(route) !== partition)
          throw new TypeError('Every subject id must route to the requested partition');
        if (!requested.has(id)) requested.set(id, route);
      }
      const pairs = [...requested].map(([id, route]) => ({ id, route }));

      const snapshot = await inSearchSnapshot(pool, async (client) => {
        const positionRow = await readPosition.run(client, { partition_no: partition });
        if (!positionRow) throw new CommandUnavailableError('fenced', partition);
        if (positionRow.writeState === 'moved')
          throw new CommandUnavailableError('moved', partition, positionRow.movedTo);
        const position = BigInt(positionRow.position);
        if (pairs.length === 0) return { partition, position, subjects: [] };

        const rows = (await readSubjects.run(client, {
          partition_no: partition,
          routes: pairs.map(({ route }) => route),
          subject_ids: pairs.map(({ id }) => id),
        })) as SubjectRow[];
        if (rows.length === 0) return { partition, position, subjects: [] };

        const found = new Map(rows.map((row) => [row.id, row]));
        const present = rows.map(({ id, route }) => ({ id, route }));
        const factRows = (await readFacts.run(client, {
          partition_no: partition,
          routes: present.map(({ route }) => route),
          subject_ids: present.map(({ id }) => id),
        })) as FactRow[];
        const expanded = factRows.filter((row) => row.entry_kind === 'expanded');
        const adoptions = expanded.length
          ? ((await readAdoptions.run(client, {
              partition_no: partition,
              routes: expanded.map(({ route }) => route),
              subject_ids: expanded.map(({ id }) => id),
              slot_ids: expanded.map(({ slot_id }) => slot_id),
            })) as AdoptionRow[])
          : [];

        const entries: StatementEntry[] = factRows.flatMap((row) => {
          if (row.entry_kind !== 'compact' || !row.candidate_id || !row.property || !row.release) return [];
          const body = object(row.body) ? row.body : {};
          const rank = selectedRank(body.rank);
          if (rank === null) return [];
          return [
            {
              source: 'compact' as const,
              route: row.route,
              subject_id: row.id,
              slot_id: row.slot_id,
              property: row.property,
              candidate_id: row.candidate_id,
              rank,
              ordinal: row.log_seq,
              body: row.body,
              release: row.release,
            },
          ];
        });
        for (const adoption of adoptions) {
          if (adoption.mode !== 'replace' || !Array.isArray(adoption.selection)) continue;
          const slot = expanded.find(
            (row) => row.route === adoption.route && row.id === adoption.subject_id && row.slot_id === adoption.slot_id,
          );
          if (!slot || !slot.property) continue;
          for (const [index, selected] of adoption.selection.entries()) {
            const selection = selectedCandidate(selected);
            if (!selection) continue;
            entries.push({
              source: 'expanded',
              route: adoption.route,
              subject_id: adoption.subject_id,
              slot_id: adoption.slot_id,
              property: slot.property,
              candidate_id: selection.candidate,
              rank: selection.rank,
              ordinal: index + 1,
            });
          }
        }

        const visible = routeKey && entries.length ? await withoutFencedEntries(client, routeKey, entries) : entries;
        const statements = visible.length
          ? ((await readStatements.run(client, { partition_no: partition, entries: visible })) as StatementRow[])
          : [];
        const digests = new Set<string>();
        for (const row of rows) if (row.currentRelease) digests.add(row.currentRelease);
        for (const row of statements) digests.add(row.release);
        const releaseRows = digests.size
          ? ((await readReleases.run(client, { route: 0, digests: [...digests] })) as {
              digest: string;
              body: Release;
            }[])
          : [];
        const releases = new Map(releaseRows.map((row) => [row.digest, row.body]));
        // A statement of a Context's own relation type was written with a composed release.
        for (const digest of digests) {
          if (releases.has(digest)) continue;
          const composed = await readRelease(client, digest);
          if (composed) releases.set(digest, composed);
        }

        const termRows = new Map<string, FactRow[]>();
        for (const row of factRows) {
          if (row.entry_kind !== 'term') continue;
          const values = termRows.get(row.id) ?? [];
          values.push(row);
          termRows.set(row.id, values);
        }
        for (const values of termRows.values())
          values.sort((left, right) => ASCII(left.slot_id, right.slot_id) || left.log_seq - right.log_seq);
        const indexed = new Map<string, Map<string, { ordinal: number; statement: IndexedStatement }[]>>();
        for (const row of statements) {
          const release = releases.get(row.release);
          if (!release) throw new Error(`Statement definition release ${row.release} is missing`);
          const statement = indexedStatement(row, release);
          if (!statement) continue;
          const properties = indexed.get(row.subject_id) ?? new Map();
          const values = properties.get(row.property) ?? [];
          values.push({ ordinal: row.ordinal, statement });
          properties.set(row.property, values);
          indexed.set(row.subject_id, properties);
        }

        const relation = await relations.prepare(client, rows, releases, partition);
        const subjects: IndexedSubject[] = [];
        for (const { id } of pairs) {
          const row = found.get(id);
          if (!row) continue;
          const facts = termRows.get(id) ?? [];
          const release = row.currentRelease ? releases.get(row.currentRelease) : undefined;
          const properties: Map<string, { ordinal: number; statement: IndexedStatement }[]> =
            indexed.get(id) ?? new Map();
          const order = release?.types[row.type]?.properties ?? [...properties.keys()].sort(ASCII);
          const orderedProperties = [
            ...order,
            ...[...properties.keys()].filter((name) => !order.includes(name)).sort(ASCII),
          ];
          const indexedStatements = orderedProperties.flatMap((property) =>
            (properties.get(property) ?? [])
              .sort((left, right) => left.ordinal - right.ordinal)
              .map(({ statement }) => statement),
          );
          subjects.push({
            id,
            type: row.type,
            visibility: row.redirect ? 'hidden' : row.visibility,
            redirect: row.redirect,
            securityRevision: Number(row.securityRevision),
            labels: termValues(facts, 'label').sort((left, right) => ASCII(left.language, right.language)),
            aliases: termValues(facts, 'alias').sort((left, right) => ASCII(left.language, right.language)),
            descriptions: termValues(facts, 'description').sort((left, right) => ASCII(left.language, right.language)),
            statements: indexedStatements,
          });
        }
        return { partition, position, subjects, relation };
      });
      // Release the source owner before independently anchoring foreign identities or tuples.
      const relation = 'relation' in snapshot ? await relations.finish(snapshot.relation) : new Map();
      for (const subject of snapshot.subjects) {
        const selected = relation.get(subject.id);
        if (!selected) continue;
        subject.statements.push(...selected.statements);
        if (selected.overflow.length) subject.relationFacetOverflow = selected.overflow;
      }
      return { partition: snapshot.partition, position: snapshot.position, subjects: snapshot.subjects };
    },

    matchRelationFacets: relations.match,

    async count(partition) {
      assertPartition(partition);
      return inSearchSnapshot(pool, async (client) => {
        const positionRow = await readPosition.run(client, { partition_no: partition });
        if (!positionRow) throw new CommandUnavailableError('fenced', partition);
        if (positionRow.writeState === 'moved')
          throw new CommandUnavailableError('moved', partition, positionRow.movedTo);
        const countRow = await count.run(client, { partition_no: partition });
        return {
          position: BigInt(positionRow.position),
          count: Number(countRow?.visible ?? '0'),
        };
      });
    },
  };
}

/** Internal same-job operation. The ordinary Source retains ALL native projection guards.
 * Only exact installed identity mappings become readable inside the scoped invocation.
 * This operation does not use subjectSource's history fold or its sampled scalar arrays.
 */
export async function readIdentitySourceProjection(
  config: Parameters<PublicFilterSourceFactory>[0],
  source: PublicFilterSource,
  request: Omit<PublicFilterProjectionRequest, 'subject'> & {
    job: IdentityJobRef;
    original: string;
    terminal: string;
  },
): Promise<
  | {
      status: 'projected';
      projection: Extract<PublicFilterProjectionPage, { status: 'progress' | 'complete' }> | null;
      cost: PublicFilterCost;
    }
  | { status: 'changed' | 'unready' | 'unavailable'; cost: PublicFilterCost }
> {
  let cost: PublicFilterCost = {
    inputKeys: 0,
    candidates: 0,
    accessPoints: 0,
    dependencyPoints: 0,
    engineSearches: 0,
    engineIteratorSteps: 0,
    outputSlots: 0,
    resultWrites: 0,
    frontierWrites: 0,
  };
  const charge = (field: 'dependencyPoints' | 'accessPoints', points = 1) => {
    cost = { ...cost, [field]: cost[field] + points };
  };
  try {
    const route = routeOf(request.original);
    if (route === null) throw new TypeError('Projection original must be a native routed ID');
    requireAccessDeadline(request.context.deadline);
    // Prepare current anonymous evidence before acquiring the original home. No caller
    // actor or editor AsyncLocal audience can replace the public resource/disclosure view.
    const resource = { route, id: request.original };
    charge('accessPoints');
    const authorize = await accessCheck(
      config.access,
      { kind: 'anonymous' },
      'subject:read',
      { ...resource, eligibility: subjectReadEligibility(resource) },
      { pool: config.pool, deadline: request.context.deadline },
    );
    const visible = await withRequestDeadline(request.context.deadline, () =>
      withReadTransaction(config.pool, async (tx) => {
        charge('dependencyPoints');
        const owner = await readPartition(tx, partitionOf(route));
        if (!owner || owner.writeState !== 'active') return 'unavailable' as const;
        charge('dependencyPoints');
        const state = await readVisibility.run(tx, {
          route,
          subject_id: request.original,
        });
        // Missing original is unknown native support, not a withheld/absent projection.
        if (!state) return 'unavailable' as const;
        if (state.visibility !== 'visible') return 'withheld' as const;
        requireAccessDeadline(request.context.deadline);
        const at = await mintReadTime(tx, config.clock);
        return (await authorize(tx, at)) ? ('visible' as const) : ('withheld' as const);
      }),
    );
    if (visible === 'unavailable') return { status: 'unavailable', cost };
    if (visible === 'withheld') return { status: 'projected', projection: null, cost };
    return await withPublicStatementReader(() =>
      withIdentitySourceSupportJob(request.job, async () => {
        charge('dependencyPoints');
        const mapping = await identityEpochStore.readMapping(config.pool, request.original);
        if (mapping.state === 'pending') return { status: 'unready', cost };
        if (mapping.state !== 'mapped') return { status: 'unavailable', cost };
        if (mapping.epoch !== request.job.epoch || mapping.terminal !== request.terminal)
          return { status: 'changed', cost };
        const page = await source.readPublicFilterProjectionPage({
          subject: request.original,
          meaning: request.meaning,
          frontier: request.frontier,
          inputLimit: request.inputLimit,
          context: request.context,
        });
        cost = Object.fromEntries(
          Object.entries(cost).map(([key, value]) => [key, value + page.cost[key as keyof PublicFilterCost]]),
        ) as PublicFilterCost;
        if (page.status !== 'progress' && page.status !== 'complete') return { status: page.status, cost };
        if (page.source.subject !== request.original || page.source.terminal !== request.terminal)
          return { status: 'changed', cost };
        charge('dependencyPoints');
        const current = await identityEpochStore.readMapping(config.pool, request.original);
        if (current.state !== 'mapped' || current.epoch !== request.job.epoch || current.terminal !== request.terminal)
          return { status: 'changed', cost };
        requireAccessDeadline(request.context.deadline);
        return { status: 'projected', projection: page, cost };
      }),
    );
  } catch (error) {
    if (classifyUnavailability(error)) return { status: 'unavailable', cost };
    throw error;
  }
}
