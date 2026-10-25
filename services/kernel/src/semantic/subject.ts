import type { Source } from '@rezics/definitions/bulk';
import { SubjectRedirectError } from './merges.ts';
import { checkSubjectInput } from '@rezics/definitions/validate';
import type { Release } from '@rezics/definitions';
import type { Pool, PoolClient } from 'pg';
import { runCommand, type CommandAuthorization, type CommandTransaction } from '../command/command.ts';
import { withConnection, discardConnection } from '../database/pool.ts';
import { readPartition } from '../partition/partition.ts';
import type { AccessCheck, AccountActor, Resource } from '../request/access.ts';
import { anchorRoute, newId, partitionOf, routeOf } from '../route/route.ts';
import { fencedIds } from './fences.ts';
import { factDataTypes, itemFacts, resolveItem, type FactRow, type Item } from './item.ts';
import { SubjectInputError } from './item.ts';
import { rejectContent } from './rules.ts';
import { GLOBAL_CONTEXT } from './definitions.ts';
import { contextSnapshot } from './context.ts';
import { LINKS_CHANGED } from './events.ts';
import { linkChanges } from './link-changes.ts';
import { slotView } from './slots.ts';
import { matchesTarget } from './targets.ts';
import createRevision from './create-revision.sql';
import insertSubject from './create-subject.sql';
import changePartitionSubjectCount from './change-partition-subject-count.sql';
import readLabelsStatement from './read-labels.sql';
import readRelatedStatement from './read-related.sql';
import readSubjectStatement from './read-subject.sql';
import readTypesStatement from './read-item-types.sql';
import { readRelease as getRelease } from './definitions.ts';
import { writeFacts } from './write-facts.ts';

export { writeFacts } from './write-facts.ts';

const BATCH_LIMIT = 256;

export const CREATE_SUBJECT = 'subject.create';
const CONTEXT = GLOBAL_CONTEXT;

/** Retries reach the partition holding their receipt while each attempt gets a new subject id. */
export function subjectTarget(routeKey: Uint8Array, accountId: string, idempotencyKey: string): Resource {
  const route = anchorRoute(routeKey, `${accountId}\n${CREATE_SUBJECT}\n${idempotencyKey}`);
  return { route, id: newId(route) };
}

export class SubjectAccessDeniedError extends Error {
  constructor() {
    super('Subject creation is not authorized');
    this.name = 'SubjectAccessDeniedError';
  }
}

export type SubjectComponent = { partition: number; epoch: number; position: bigint };
export type CreateSubjectResult = { subject: Item; component: SubjectComponent; replayed: boolean };

export async function createSubject(
  pool: Pool,
  options: {
    actor: AccountActor;
    target: Resource;
    idempotencyKey: string;
    digest: Uint8Array;
    item: unknown;
    release: { digest: string; release: Release };
    authorize?: AccessCheck;
    authorization?: CommandAuthorization;
    deadline?: number;
  },
): Promise<CreateSubjectResult> {
  const checked = checkSubjectInput(options.item, options.release.release, rejectContent);
  if (checked.violations.length) throw new SubjectInputError(checked.violations);
  const { route, id: subjectId } = options.target;
  if (routeOf(subjectId) !== route) throw new RangeError('Subject target id must carry its route');
  const partition = partitionOf(route);
  const command = await runCommand(
    pool,
    {
      partition,
      ...(options.deadline === undefined ? {} : { deadline: options.deadline }),
      receipt: {
        actorAccountId: options.actor.accountId,
        kind: CREATE_SUBJECT,
        key: options.idempotencyKey,
        digest: options.digest,
      },
      basis: {
        actorAccountId: options.actor.accountId,
        clientId: options.actor.clientId,
        requestedBy: options.actor.requestedBy,
      },
      authorization: options.authorization ?? {
        action: 'subject:create',
        resource: options.target,
        denied: () => new SubjectAccessDeniedError(),
        async authorize(tx, attempt) {
          if (!options.authorize || !(await options.authorize(tx, attempt.time))) throw new SubjectAccessDeniedError();
          return 'execute';
        },
      },
    },
    async (tx, { transactionId }) => {
      return writeSubject(tx, transactionId, options);
    },
  );
  return {
    subject: command.value,
    component: { partition: command.partition, epoch: command.epoch, position: command.position },
    replayed: command.replayed,
  };
}

/** The same creation work for individual writes and imported records. */
export async function writeSubject(
  tx: CommandTransaction,
  transactionId: string,
  options: Pick<Parameters<typeof createSubject>[1], 'target' | 'item' | 'release'> & { source?: Source },
) {
  const { route, id: subjectId } = options.target;
  const input = options.item as Record<string, unknown>;
  const checked = checkSubjectInput(options.item, options.release.release, rejectContent);
  if (checked.violations.length) throw new SubjectInputError(checked.violations);
  const facts = itemFacts(subjectId, options.item, typeof input?.type === 'string' ? input.type : undefined);
  const dataTypes = factDataTypes(options.release.release, facts);
  const itemTypes = await readItemTypes(
    tx,
    checked.targets.map((item) => item.id),
  );
  const targetErrors = checked.targets.flatMap((item) => {
    const targetType = itemTypes.get(item.id);
    return targetType && matchesTarget(options.release.release, targetType, item.targets)
      ? []
      : [{ pointer: item.pointer, code: 'out_of_range' as const }];
  });
  if (targetErrors.length) throw new SubjectInputError(targetErrors);
  await insertSubject.run(tx, {
    route,
    subject_id: subjectId,
    type: String(input.type),
    transaction_id: transactionId,
    current_facts: facts.length,
    current_release: options.release.digest,
  });
  await createRevision.run(tx, {
    route,
    subject_id: subjectId,
    release: options.release.digest,
    transaction_id: transactionId,
    source: options.source ?? null,
  });
  await writeFacts(tx, {
    route,
    subject_id: subjectId,
    transaction_id: transactionId,
    facts: facts.map((fact) => ({ ...fact, release: fact.kind === 'statement' ? options.release.digest : null })),
  });
  await changePartitionSubjectCount.run(tx, { partition_no: partitionOf(route), delta: 1 });
  const events: { type: string; subject: string; data: unknown }[] = [
    { type: 'com.rezics.subject.created.v1', subject: subjectId, data: { id: subjectId } },
  ];
  const changes = linkChanges([], facts, dataTypes);
  if (changes.length > 0) {
    events.push({
      type: LINKS_CHANGED,
      subject: subjectId,
      data: { subject: subjectId, revision: 1, security_revision: 0, changes },
    });
  }
  return {
    value: resolveItem(subjectId, facts, String(input.type), dataTypes, {
      revision: 1,
      release: options.release.digest,
      context: CONTEXT,
    }),
    events,
  };
}

type SubjectReadRow = {
  id: string;
  redirect: string | null;
  type: string;
  revision: number;
  release: string;
  fact_revision: number | null;
  fact_release: string | null;
  slot_id: string | null;
  log_seq: number | null;
  operation: FactRow['operation'] | null;
  kind: FactRow['kind'] | null;
  language: string | null;
  property: string | null;
  statement_id: string | null;
  body: unknown;
};

function asFacts(rows: readonly SubjectReadRow[]): FactRow[] {
  return rows.flatMap((row) =>
    row.slot_id === null || row.log_seq === null || row.operation === null || row.kind === null
      ? []
      : [
          {
            slot_id: row.slot_id,
            log_seq: row.log_seq,
            operation: row.operation,
            kind: row.kind,
            language: row.language,
            property: row.property,
            statement_id: row.statement_id,
            body: row.body,
            fact_revision: row.fact_revision,
            fact_release: row.fact_release,
          },
        ],
  );
}

async function rollback(client: PoolClient, error: unknown): Promise<never> {
  try {
    await client.query('ROLLBACK');
  } catch (rollbackError) {
    discardConnection(client, rollbackError as Error);
  }
  throw error;
}

async function withoutFencedFacts(
  client: PoolClient,
  routeKey: Uint8Array,
  route: number,
  subjectId: string,
  facts: FactRow[],
): Promise<FactRow[]> {
  const revisions = [
    ...new Set(facts.flatMap((fact) => (fact.statement_id && fact.fact_revision ? [fact.fact_revision] : []))),
  ];
  // Always probe, including an empty list, so hiding the last shown statement does not drop a statement.
  const result = await client.query<{ revision: number; source: Source | null }>(
    `SELECT probed.revision, probed.source
     FROM unnest($3::int[]) AS wanted(revision)
     JOIN LATERAL (
       SELECT revision, source FROM semantic.revision
       WHERE route = $1 AND subject_id = $2 AND revision = wanted.revision
       OFFSET 0
       LIMIT 1
     ) probed ON true`,
    [route, subjectId, revisions],
  );
  if (!revisions.length) return facts;
  const sources = new Map(result.rows.map((row) => [row.revision, row.source]));
  const gone = await fencedIds(
    client,
    routeKey,
    facts.flatMap((fact) =>
      fact.statement_id && fact.fact_revision
        ? [{ id: fact.statement_id, source: sources.get(fact.fact_revision) ?? null }]
        : [],
    ),
  );
  return facts.filter((fact) => fact.statement_id === null || !gone.has(fact.statement_id));
}

export async function readSubject(
  pool: Pool,
  id: string,
  authorize: (client: PoolClient) => Promise<boolean>,
  context = GLOBAL_CONTEXT,
  routeKey?: Uint8Array,
): Promise<{ subject: Item; component: SubjectComponent } | null> {
  const route = routeOf(id);
  if (route === null) return null;
  const contextRecord = context === GLOBAL_CONTEXT ? null : await contextSnapshot(pool, context);
  if (context !== GLOBAL_CONTEXT && !contextRecord) return null;
  const defaults = contextRecord?.defaults ?? {};
  const snapshot = await withConnection(pool, async (client) => {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      await client.query("SET LOCAL statement_timeout = '300ms'");
      const partition = await readPartition(client, partitionOf(route));
      if (!partition) {
        await client.query('COMMIT');
        return null;
      }
      const rows = (await readSubjectStatement.run(client, { route, subject_id: id })) as SubjectReadRow[];
      if (!rows.length) {
        await client.query('COMMIT');
        return null;
      }
      const allowed = await authorize(client);
      if (allowed && rows[0]!.redirect) throw new SubjectRedirectError(id, rows[0]!.redirect);
      const release = await getRelease(client, rows[0]!.release);
      if (!release) throw new Error('Subject revision release is missing');
      let statementFacts: FactRow[] = [];
      const resolution: Record<string, 'unresolved' | 'suppressed'> = {};
      if (allowed) {
        for (const property of release.types[rows[0]!.type]!.properties) {
          const view = await slotView(client, id, property, context, defaults);
          statementFacts.push(...view.facts);
          if (view.resolution) resolution[property] = view.resolution;
        }
        if (routeKey) statementFacts = await withoutFencedFacts(client, routeKey, route, id, statementFacts);
      }
      await client.query('COMMIT');
      if (!allowed) return null;
      return {
        rows,
        statementFacts,
        release,
        component: { partition: partition.partitionNo, epoch: partition.epoch, position: partition.position },
        resolution,
      };
    } catch (error) {
      return await rollback(client, error);
    }
  });
  if (!snapshot) return null;
  const { rows, component, release, statementFacts, resolution } = snapshot;
  const dataTypes = factDataTypes(release, [...asFacts(rows), ...statementFacts]);
  return {
    subject: resolveItem(id, [...asFacts(rows), ...statementFacts], rows[0]!.type, dataTypes, {
      revision: rows[0]!.revision,
      release: rows[0]!.release,
      context,
      resolution,
    }),
    component,
  };
}

type Queryable = Pick<PoolClient, 'query'>;

function assertBatch(ids: readonly string[], message: string): void {
  if (ids.length > BATCH_LIMIT) throw new TypeError(message);
}

function groupsOf(ids: readonly string[]): Map<number, string[]> {
  const groups = new Map<number, string[]>();
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const route = routeOf(id);
    if (route === null) continue;
    const partition = partitionOf(route);
    const group = groups.get(partition) ?? [];
    group.push(id);
    groups.set(partition, group);
  }
  return groups;
}

/** Item targets of one write, one primary-key probe per id and one statement per partition. */
export async function readItemTypes(client: Queryable, ids: readonly string[]): Promise<Map<string, string>> {
  assertBatch(ids, 'An item type check accepts at most 256 ids');
  const types = new Map<string, string>();
  for (const subjectIds of groupsOf(ids).values()) {
    const rows = (await readTypesStatement.run(client, {
      routes: subjectIds.map((id) => routeOf(id)!),
      subject_ids: subjectIds,
    })) as { id: string; type: string }[];
    for (const row of rows) types.set(row.id, row.type);
  }
  return types;
}

export async function readLabels(pool: Pool, ids: readonly string[]): Promise<Map<string, Item['labels']>> {
  assertBatch(ids, 'A label fill accepts at most 256 ids');
  const labels = new Map<string, Item['labels']>();
  await Promise.all(
    [...groupsOf(ids).values()].map(async (subjectIds) => {
      const rows = (await readLabelsStatement.run(pool, {
        routes: subjectIds.map((id) => routeOf(id)!),
        subject_ids: subjectIds,
      })) as { id: string; labels: Record<string, string> }[];
      for (const row of rows) labels.set(row.id, row.labels ?? {});
    }),
  );
  return labels;
}

export type RelatedState = {
  id: string;
  visibility: string;
  security_revision: string;
  redirect: string | null;
  labels: Item['labels'];
};

type RelatedCache = { ids: string[]; pending: Promise<Map<string, RelatedState>> };
const relatedLoads = new WeakMap<object, RelatedCache>();

async function queryRelated(client: Queryable, ids: readonly string[]): Promise<Map<string, RelatedState>> {
  const states = new Map<string, RelatedState>();
  for (const subjectIds of groupsOf(ids).values()) {
    const rows = (await readRelatedStatement.run(client, {
      routes: subjectIds.map((id) => routeOf(id)!),
      subject_ids: subjectIds,
    })) as RelatedState[];
    for (const row of rows) states.set(row.id, { ...row, labels: row.labels ?? {} });
  }
  return states;
}

/** One statement per partition for visibility, eligibility, labels and redirects. Repeated calls on the same client reuse a superset. */
export function loadRelated(client: object, ids: readonly string[]): Promise<Map<string, RelatedState>> {
  assertBatch(ids, 'A related read accepts at most 256 ids');
  const known = relatedLoads.get(client);
  if (known && ids.every((id) => known.ids.includes(id))) return known.pending;
  const pending = queryRelated(client as Queryable, ids).then(async (fetched) => {
    const prior = known ? await known.pending : new Map<string, RelatedState>();
    const merged = new Map(prior);
    for (const [id, state] of fetched) merged.set(id, state);
    return merged;
  });
  relatedLoads.set(client, { ids: [...new Set([...(known?.ids ?? []), ...ids])], pending });
  return pending;
}

function isPool(value: Pool | PoolClient): value is Pool {
  return typeof (value as Pool).connect === 'function' && typeof (value as PoolClient).release !== 'function';
}

/** Labels of the requested ids, following one redirect, from the shared related read. */
export async function readRelated(db: Pool | PoolClient, ids: readonly string[]) {
  assertBatch(ids, 'A related read accepts at most 256 ids');
  const assemble = async (client: PoolClient) => {
    const states = await loadRelated(client, ids);
    const targets = [
      ...new Set(
        ids.flatMap((id) => {
          const state = states.get(id);
          return state?.visibility === 'visible' && state.redirect ? [state.redirect] : [];
        }),
      ),
    ];
    const targetStates = targets.length > 0 ? await loadRelated(client, targets) : states;
    const related: Record<string, { labels: Item['labels']; redirect?: string }> = {};
    for (const id of ids) {
      const state = states.get(id);
      if (!state || state.visibility !== 'visible') continue;
      const target = state.redirect;
      if (target) {
        const redirected = targetStates.get(target);
        if (!redirected || redirected.visibility !== 'visible') continue;
        related[id] = { redirect: target, labels: redirected.labels };
        continue;
      }
      related[id] = { labels: state.labels };
    }
    return related;
  };
  if (isPool(db)) return withConnection(db, assemble);
  return assemble(db);
}
