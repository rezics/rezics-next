import { isDeepStrictEqual } from 'node:util';
import { jsonParameter } from '../database/json.ts';
import type { ConceptStatementReader } from '../search/concept-browse-statements.ts';
import { indexedStatement, selectedRank } from './scope-leaf-selection.ts';
export { indexedStatement } from './scope-leaf-selection.ts';
import {
  readSubjectKeyPage,
  createSubjectCanonicalNames,
  type SubjectCanonicalNames,
  type SubjectSourceKeyTraversal as SubjectSourceKeyPages,
} from './subject-source-key-pages.ts';
import type { Release } from '@rezics/definitions';
import { relationSource } from './search-relations.ts';
import { readRelease } from './definition-release-read.ts';
import type { Pool, PoolClient } from 'pg';
import {
  AccessUnavailableError,
  classifyUnavailability,
  CommandUnavailableError,
  requireAccessDeadline,
  throwAccessUnavailable,
} from '../access/unavailable.ts';
import { withoutFencedEntries } from './fences.ts';
import { PARTITIONS, partitionOf, routeOf } from '../route/route.ts';
import type { IndexedStatement, IndexedSubject, SubjectSnapshot, SubjectSource } from '../search/source.ts';
import count from './search-source-count.sql';
import readCurrentStatements from './search-source-current-statements.sql';
import readFacts from './search-source-facts.sql';
import rebuildSelection from './search-selected-rebuild.sql';
import readReleases from './search-source-releases.sql';
import readPosition from './search-source-position.sql';
import readStatements from './search-source-statements.sql';
import readSubjects from './search-source-subjects.sql';
import { accessCheck, prepareReadDecisions } from '../request/access.ts';
import { commandTime, DEFAULT_REQUEST_DEADLINE_MS, mintReadTime, type CommandTransaction } from '../command/command.ts';
import { nativeSourceQuery } from '../database/native-source-query.ts';
import { withBoundedReadConnection } from '../database/pool.ts';
import { readPartition, type Partition } from '../partition/partition.ts';
import { subjectReadEligibility } from './eligibility.ts';
import { withPublicStatementReader } from './statement-disclosure.ts';
import { withIdentitySourceSupportJob } from './identity-source-support-scope.ts';
import { readIdentitySupportMappingsInSnapshot } from './identity-adapters/identity-epoch-read.ts';
import { verifyCompletedPublicFilterProjectionInSnapshot } from './public-filter-projection.ts';
import type { IdentityJobRef } from './identity-epoch-contract.ts';
import type {
  PublicFilterCost,
  PublicFilterProjectionFrontier,
  PublicFilterProjectionPage,
  PublicFilterProjectionRequest,
  PublicFilterProjectionRetirement,
  PublicFilterSource,
  PublicFilterSourceFactory,
} from './public-filter-source-contract.ts';
import readVisibility from './read-visibility.sql';
import readRelatedStates from './read-subject-related-states.sql';
import { withReadTransaction } from './read.ts';
import { deadlineFor, withRequestDeadline } from '../request/deadline.ts';

export { readPartition };

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
  rank?: 'normal' | 'preferred' | null;
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

/** Existing `read` id cap; a larger batch is refused before SQL. */
export const SEARCH_SOURCE_SUBJECT_BATCH = 256;
/** `current_facts` current-slot budget per Subject. */
export const SEARCH_SOURCE_CURRENT_SLOT_BUDGET = 512;
/** Global adoption selection cap per expanded slot. */
export const SEARCH_SOURCE_CURRENT_CANDIDATE_BUDGET = 32;
const CURRENT_STATEMENT_LIMIT = SEARCH_SOURCE_CURRENT_SLOT_BUDGET * SEARCH_SOURCE_CURRENT_CANDIDATE_BUDGET + 1;

/** Current name/fact/visibility publication fence used by complete Search traversals. */
export const readSearchCanonicalGenerationSql =
  'SELECT last_value::text,is_called FROM semantic.search_canonical_generation';
export async function readSearchCanonicalGeneration(pool: CommandTransaction): Promise<string> {
  const result = await pool.query<{ last_value: string; is_called: boolean }>(readSearchCanonicalGenerationSql);
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
  return withReadTransaction(pool, work);
}

function isSettledServerError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const details = error as { code?: unknown; severity?: unknown };
  return typeof details.code === 'string' && /^[0-9A-Z]{5}$/.test(details.code) && details.severity === 'ERROR';
}

/** Repair one unreadied subject on the caller's Search deadline, then let the read refuse. */
async function resumeSelection(pool: Pool, deadline: number, pending: Pick<SubjectRow, 'route' | 'id'>): Promise<void> {
  await withBoundedReadConnection(
    pool,
    deadline,
    async (client) => {
      requireAccessDeadline(deadline);
      await rebuildSelection.run(client, { route: pending.route, subject_id: pending.id });
      requireAccessDeadline(deadline);
    },
    {
      deadlineError: () => new AccessUnavailableError('deadline'),
      mapError(error) {
        try {
          // The bounded lifetime selects the deadline race; classify its settled failure without checking time again.
          throwAccessUnavailable(error);
        } catch (mapped) {
          return mapped;
        }
        return error;
      },
      isUncertainError: (error) => classifyUnavailability(error) !== undefined,
      isUncertainSettledQueryError: (error) => !isSettledServerError(error),
    },
  );
}

export function subjectSource(
  pool: Pool,
  routeKey?: Uint8Array,
): SubjectSource &
  SubjectSourceKeyPages & {
    canonicalNames: SubjectCanonicalNames;
    conceptBrowse: ReturnType<typeof relationSource>['conceptBrowse'];
    readConceptStatements: ConceptStatementReader;
    readCompleteWorkLinks: NonNullable<SubjectSource['readCompleteWorkLinks']>;
  } {
  const relations = relationSource(pool, routeKey);
  return {
    readSubjectKeyPage,
    canonicalNames: createSubjectCanonicalNames(pool),
    async read(partition, ids): Promise<SubjectSnapshot> {
      assertPartition(partition);
      if (ids.length > SEARCH_SOURCE_SUBJECT_BATCH) throw new TypeError('A subject snapshot accepts at most 256 ids');
      const requested = new Map<string, number>();
      for (const id of ids) {
        const route = routeOf(id);
        if (route === null || partitionOf(route) !== partition)
          throw new TypeError('Every subject id must route to the requested partition');
        if (!requested.has(id)) requested.set(id, route);
      }
      const pairs = [...requested].map(([id, route]) => ({ id, route }));

      // Keep the original cut for the snapshot, any selection repair, and relation disclosure.
      const deadline = deadlineFor(DEFAULT_REQUEST_DEADLINE_MS);
      const snapshot = await withReadTransaction(pool, async (client) => {
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
        const unreadied = rows.find((row) => !row.selection_ready);
        if (unreadied)
          return { partition, position, subjects: [] as IndexedSubject[], pending: unreadied, rebuild: true };
        const present = rows.map(({ id, route }) => ({ id, route }));
        const factRows = (await readFacts.run(client, {
          partition_no: partition,
          routes: present.map(({ route }) => route),
          subject_ids: present.map(({ id }) => id),
        })) as FactRow[];
        const currentRows = (await readCurrentStatements.run(client, {
          partition_no: partition,
          routes: present.map(({ route }) => route),
          subject_ids: present.map(({ id }) => id),
          subject_limit: CURRENT_STATEMENT_LIMIT,
        })) as FactRow[];
        const currentCounts = new Map<string, number>();
        for (const row of currentRows) currentCounts.set(row.id, (currentCounts.get(row.id) ?? 0) + 1);
        const overflow = present.find(({ id }) => (currentCounts.get(id) ?? 0) >= CURRENT_STATEMENT_LIMIT);
        if (overflow)
          return { partition, position, subjects: [] as IndexedSubject[], pending: overflow, rebuild: false };

        const entries: StatementEntry[] = currentRows.flatMap((row) => {
          if (!row.candidate_id || !row.property || !row.release) return [];
          const body = object(row.body) ? row.body : {};
          const rank = selectedRank(row.rank) ?? selectedRank(body.rank);
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

        const visible = routeKey && entries.length ? await withoutFencedEntries(client, routeKey, entries) : entries;
        const statements = visible.length
          ? ((await readStatements.run(client, {
              partition_no: partition,
              entries: jsonParameter(visible),
            })) as StatementRow[])
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
      }, deadline);
      if ('pending' in snapshot && snapshot.pending) {
        if (snapshot.rebuild) await resumeSelection(pool, deadline, snapshot.pending);
        throw new CommandUnavailableError('contention', partition);
      }
      // Release the source owner before independently anchoring foreign identities or tuples.
      const preparedRelation = snapshot.relation;
      const relation = preparedRelation
        ? await withRequestDeadline(deadline, () => relations.finish(preparedRelation))
        : new Map();
      requireAccessDeadline(deadline);
      for (const subject of snapshot.subjects) {
        const selected = relation.get(subject.id);
        if (!selected) continue;
        subject.statements.push(...selected.statements);
        if (selected.overflow.length) subject.relationFacetOverflow = selected.overflow;
      }
      requireAccessDeadline(deadline);
      return { partition: snapshot.partition, position: snapshot.position, subjects: snapshot.subjects };
    },

    matchRelationFacets: relations.match,
    prepareRelationFacets: relations.preparePage,
    conceptBrowse: relations.conceptBrowse,
    readConceptStatements: relations.readConceptStatements,
    readCompleteWorkLinks: relations.readCompleteWorkLinks,

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

/** Revalidate retained support using one released snapshot of the installed native Pool. */
export async function prepareRetainedIdentitySourceProjections(
  config: Parameters<PublicFilterSourceFactory>[0],
  input: Readonly<{
    job: IdentityJobRef;
    original: string;
    terminal: string;
    release: string;
    originalSupport: PublicFilterProjectionFrontier | null;
    terminalSupport: PublicFilterProjectionFrontier | null;
    deadline: number;
    phase?: 'original' | 'terminal';
  }>,
): Promise<((tx: CommandTransaction) => Promise<ReadonlyMap<number, Partition> | null>) | null> {
  if (input.original === input.terminal && !isDeepStrictEqual(input.originalSupport, input.terminalSupport))
    return null;
  const requested =
    input.phase === 'terminal'
      ? [{ id: input.terminal, frontier: input.terminalSupport }]
      : [{ id: input.original, frontier: input.originalSupport }];
  if (!input.phase && input.original !== input.terminal)
    requested.push({ id: input.terminal, frontier: input.terminalSupport });
  if (requested.some(({ id }) => routeOf(id) === null)) return null;
  const actor = { kind: 'anonymous' } as const;
  const context = { pool: config.pool, deadline: input.deadline };
  const batch =
    requested.length === 2 && config.access.prepareReadDecisions
      ? await prepareReadDecisions(config.access, { actor, actions: new Set(['subject:read']), context })
      : null;
  const checks: {
    id: string;
    route: number;
    frontier: PublicFilterProjectionFrontier | null;
    authorize: Awaited<ReturnType<typeof accessCheck>> | null;
  }[] = [];
  for (const item of requested) {
    const route = routeOf(item.id);
    if (route === null) return null;
    const resource = { route, id: item.id };
    const authorize = batch
      ? null
      : await accessCheck(
          config.access,
          actor,
          'subject:read',
          { ...resource, eligibility: subjectReadEligibility(resource) },
          context,
        );
    checks.push({ ...item, route, authorize });
  }
  return async (tx) => {
    const visibleIds: string[] = [];
    const owners = new Map<number, Partition>();
    for (const { id, route, frontier } of checks) {
      const partition = partitionOf(route);
      let owner = owners.get(partition);
      if (!owner) {
        const current = await readPartition(tx, partition);
        if (!current || current.writeState !== 'active') return null;
        owner = current;
        owners.set(partition, owner);
      }
      if (!frontier) continue;
      if (
        !(await verifyCompletedPublicFilterProjectionInSnapshot(
          tx,
          config.routeKey,
          id,
          input.terminal,
          input.release,
          owner.epoch,
          frontier,
        ))
      )
        return null;
      visibleIds.push(id);
    }
    let at: Awaited<ReturnType<typeof mintReadTime>> | undefined;
    let decisions: Awaited<ReturnType<NonNullable<typeof batch>['decide']>> | null = null;
    if (batch) {
      // The completed builds prove the current public visibility floor on this same snapshot.
      const publicSubjects = new Map(visibleIds.map((id) => [id, true]));
      const unproven = checks.filter(({ frontier }) => !frontier);
      const homes = new Set(unproven.map(({ route }) => partitionOf(route)));
      for (const partition of homes) {
        const members = unproven.filter(({ route }) => partitionOf(route) === partition);
        const states = (await nativeSourceQuery(tx, readRelatedStates, {
          partition_no: partition,
          routes: members.map(({ route }) => route),
          subject_ids: members.map(({ id }) => id),
        })) as { id: string; visibility: string | null }[];
        for (const { id, visibility } of states)
          if (visibility !== null) publicSubjects.set(id, visibility === 'visible');
      }
      const ids = checks.map(({ id }) => id);
      if (ids.some((id) => !publicSubjects.has(id))) return null;
      at = commandTime(tx) ?? (await mintReadTime(tx, config.clock, config.pool));
      decisions = await batch.decide(
        tx,
        {
          ids,
          action: 'subject:read',
          resourceType: 'semantic.subject',
          // These are the current floor rows from this same retained Source snapshot.
          eligibility: async (_client, targets) =>
            Object.fromEntries(targets.map((id) => [id, publicSubjects.get(id) === true])),
        },
        at,
      );
    }
    for (const check of checks) {
      let visible = decisions?.[check.id]?.allowed === true;
      if (check.authorize) {
        const state = await nativeSourceQuery(tx, readVisibility, { route: check.route, subject_id: check.id });
        if (!state) return null;
        if (state.visibility === 'visible') {
          at ??= commandTime(tx) ?? (await mintReadTime(tx, config.clock, config.pool));
          visible = await check.authorize(tx, at);
        }
      }
      if (visible !== Boolean(check.frontier)) return null;
    }
    if (visibleIds.length) {
      const mappings = await readIdentitySupportMappingsInSnapshot(tx, visibleIds, input.job, owners);
      if (
        mappings.some(
          (mapping) =>
            mapping.state !== 'mapped' || mapping.terminal !== input.terminal || mapping.epoch !== input.job.epoch,
        )
      )
        return null;
    }
    requireAccessDeadline(input.deadline);
    return owners;
  };
}

class IdentityProjectionRefusal extends Error {
  constructor(readonly state: 'withheld' | 'unavailable' | 'unready' | 'changed') {
    super(state);
  }
}

/** Resolve the exact admitted root on the native projection's Source snapshot. */
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
  | {
      status: 'changed' | 'unready' | 'unavailable';
      cost: PublicFilterCost;
      retirement?: PublicFilterProjectionRetirement;
    }
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
    let checked = false;
    return await withPublicStatementReader(() =>
      withIdentitySourceSupportJob(request.job, async () => {
        // A resumed cursor authenticates the retained build. A complete page still
        // rechecks the live job mapping before it can support any writer action.
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
        if (page.status === 'unready' && page.retirement)
          return { status: page.status, cost, retirement: page.retirement };
        if (page.status !== 'progress' && page.status !== 'complete') return { status: page.status, cost };
        if (!checked) return { status: 'unavailable', cost };
        if (page.source.subject !== request.original || page.source.terminal !== request.terminal)
          return { status: 'changed', cost };
        if (page.status === 'progress') {
          requireAccessDeadline(request.context.deadline);
          return { status: 'projected', projection: page, cost };
        }
        charge('dependencyPoints');
        const [current] = await withReadTransaction(
          config.pool,
          (tx) => readIdentitySupportMappingsInSnapshot(tx, [request.original], request.job),
          request.context.deadline,
        );
        if (
          current?.state !== 'mapped' ||
          current.epoch !== request.job.epoch ||
          current.terminal !== request.terminal
        )
          return { status: 'changed', cost };
        requireAccessDeadline(request.context.deadline);
        return { status: 'projected', projection: page, cost };
      }, {
        original: request.original,
        async check(tx, owner, visibility, time) {
          if (owner.partitionNo !== partitionOf(route) || owner.writeState !== 'active')
            throw new IdentityProjectionRefusal('unavailable');
          if (visibility !== 'visible') throw new IdentityProjectionRefusal('withheld');
          if (!time) throw new IdentityProjectionRefusal('unavailable');
          if (!(await authorize(tx, time))) throw new IdentityProjectionRefusal('withheld');
          if (!request.frontier) {
            charge('dependencyPoints');
            const [mapping] = await readIdentitySupportMappingsInSnapshot(
              tx, [request.original], request.job, new Map([[owner.partitionNo, owner]]),
            );
            if (mapping?.state === 'pending') throw new IdentityProjectionRefusal('unready');
            if (mapping?.state !== 'mapped') throw new IdentityProjectionRefusal('unavailable');
            if (mapping.epoch !== request.job.epoch || mapping.terminal !== request.terminal)
              throw new IdentityProjectionRefusal('changed');
          }
          checked = true;
        },
      }),
    );
  } catch (error) {
    if (error instanceof IdentityProjectionRefusal) {
      if (error.state === 'withheld') return { status: 'projected', projection: null, cost };
      return { status: error.state, cost };
    }
    if (classifyUnavailability(error)) return { status: 'unavailable', cost };
    throw error;
  }
}
