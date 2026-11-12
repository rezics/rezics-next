import { createResourcePublicEligibility, type ResourceEligibility } from '../access/eligibility.ts';
import type {
  ResourceEligibilityPrepareContext,
  ResourceEligibilityVerifyContext,
} from '../access/public-eligibility.ts';
import { addAccessWork, EMPTY_ACCESS_WORK, type AccessWork, type AccessWorkProducer } from '../access/work.ts';
import type { PoolClient, QueryResultRow } from 'pg';
import { withConnection } from '../database/pool.ts';
import type { ReadDecisionEligibility } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import contextPublicExists from './context-public-exists.sql';
import contextPublicEvidence from './context-public-evidence.sql';
import { GLOBAL_SUBJECT_CONTEXT as GLOBAL_CONTEXT } from './contract/subject-values.ts';
import subjectPublicEvidence from './scope-leaf-evidence-eligibility.sql';
import readSubjectRelatedStates from './read-subject-related-states.sql';

const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value) ?? 'null');
type Identity = { route: number; id: string };
// Both SQL parameter names (subject_id and context_id) have the same UTF-8 size.
const parameterBytes = (identity: Identity): number => bytes({ route: identity.route, subject_id: identity.id });
/** Execute only the declared point plan. The typed run() convenience wrapper can
 * dispatch catalogue freshness reads, which have no place in a reserved receipt.
 */
async function point<I extends Record<string, unknown>, R extends QueryResultRow>(
  client: Pick<PoolClient, 'query'>,
  statement: { sql: string; params: readonly string[]; '~reylo': { input: I; element: R } },
  input: I,
): Promise<R | null> {
  return (
    (
      await client.query<R>(
        statement.sql,
        statement.params.map((name) => input[name]),
      )
    ).rows[0] ?? null
  );
}
type PublicState = { visibility: string; security_revision: string } | null;
type Prepare = ResourceEligibilityPrepareContext;
type Verify<E> = ResourceEligibilityVerifyContext<E>;

/** One exact primary-key probe, including an empty probe. No history or payload
 * ranges enter these plans. Prepare additionally acquires and releases one pool
 * connection; verify uses the supplied resource connection. Native examined work
 * is the dispatched point plan, never the count of returned rows.
 */
function pointWork(identity: Identity, projectionBytes: number, checkout: boolean): AccessWork {
  return {
    keys: 1,
    points: checkout ? 2 : 1,
    witnesses: 0,
    rows: 1,
    bytes: parameterBytes(identity) + projectionBytes,
    emptySeeks: 1,
  };
}

/** Receipts belong to the exact callback invocation, including branches that
 * dispatch nothing. Access reserves the declaration before calling run. A failed
 * callback has no successful receipt and Access burns its reserved bound.
 */
function measured<C extends object, R>(
  bound: (context: C) => AccessWork,
  dispatch: (context: C) => Promise<{ value: R; usage: AccessWork }>,
): { run(context: C): Promise<R>; producer: AccessWorkProducer<C, R> } {
  const receipts = new WeakMap<C, AccessWork>();
  return {
    async run(context) {
      const result = await dispatch(context);
      receipts.set(context, result.usage);
      return result.value;
    },
    producer: {
      bound,
      actual(context) {
        const receipt = receipts.get(context);
        receipts.delete(context);
        return receipt;
      },
    },
  };
}

// Visibility is a closed enum and security_revision is a nonnegative bigint.
// Deliberately omit the unbounded type and label columns from eligibility IO.
const publicStateBytes = bytes({ visibility: 'taken_down', security_revision: '9223372036854775807' });

async function publicState(
  client: ResourceEligibilityVerifyContext<unknown>['client'],
  identity: Identity,
  checkout: boolean,
): Promise<{ value: PublicState; usage: AccessWork }> {
  const row = (await point(client, subjectPublicEvidence, { route: identity.route, subject_id: identity.id })) ?? null;
  return {
    value: row,
    usage: {
      ...pointWork(identity, publicStateBytes, checkout),
      bytes: parameterBytes(identity) + bytes(row),
      emptySeeks: row === null ? 1 : 0,
    },
  };
}

export type GlobalReadAction = 'subject:read' | 'definitions:read' | 'presentation:read';

const globalReadActions: ReadonlySet<string> = new Set(['subject:read', 'definitions:read', 'presentation:read']);

export function globalReadEligibility(action: GlobalReadAction): ResourceEligibility {
  if (!globalReadActions.has(action)) throw new TypeError('Unsupported global read action');

  const resource = { route: 0, id: GLOBAL_CONTEXT };
  const prepare = measured<Prepare, { kind: string } | null>(
    ({ resource }) => pointWork(resource, bytes({ kind: 'community' }), true),
    async ({ pool, resource: identity }) => {
      const row =
        (await withConnection(pool, (client) =>
          point(client, contextPublicEvidence, { route: identity.route, context_id: identity.id }),
        )) ?? null;
      return {
        value: row,
        usage: {
          ...pointWork(identity, bytes({ kind: 'community' }), true),
          bytes: parameterBytes(identity) + bytes(row),
          emptySeeks: row === null ? 1 : 0,
        },
      };
    },
  );
  const verify = measured<Verify<{ kind: string } | null>, boolean>(
    ({ resource }) => pointWork(resource, bytes({ '?column?': 1 }), false),
    async ({ client, resource: identity }) => {
      const row = await point(client, contextPublicExists, { route: identity.route, context_id: identity.id });
      return {
        value: row !== null,
        usage: {
          ...pointWork(identity, bytes({ '?column?': 1 }), false),
          bytes: parameterBytes(identity) + bytes(row),
          emptySeeks: row === null ? 1 : 0,
        },
      };
    },
  );
  return createResourcePublicEligibility({
    resource,
    action,
    work: { prepare: prepare.producer, verify: verify.producer },
    prepare: prepare.run,
    verify: verify.run,
  });
}

/** Related-read floor for a bounded summary page: visibility alone, one exact subject point each. */
export async function relatedReadVisibility(
  client: ResourceEligibilityVerifyContext<unknown>['client'],
  ids: readonly string[],
): Promise<Readonly<Record<string, boolean>>> {
  if (ids.length > 256) throw new TypeError('A related read accepts at most 256 ids');
  const result: Record<string, boolean> = Object.create(null);
  const groups = new Map<number, Identity[]>();
  for (const id of ids) {
    const route = routeOf(id);
    if (route === null) {
      result[id] = false;
      continue;
    }
    const partition = partitionOf(route);
    const group = groups.get(partition) ?? [];
    group.push({ route, id });
    groups.set(partition, group);
  }
  for (const [partition, entries] of groups) {
    const rows = (await readSubjectRelatedStates.run(client, {
      partition_no: partition,
      routes: entries.map(({ route }) => route),
      subject_ids: entries.map(({ id }) => id),
    })) as { id: string; visibility: string | null }[] | { id: string; visibility: string | null } | null;
    const found = rows == null ? [] : Array.isArray(rows) ? rows : [rows];
    for (const row of found) result[row.id] = row.visibility === 'visible';
    for (const { id } of entries) if (!Object.hasOwn(result, id)) result[id] = false;
  }
  return result;
}

function relatedReadPointWork(ids: readonly string[]): AccessWork {
  return addAccessWork(
    EMPTY_ACCESS_WORK,
    ...ids.map((id) => {
      const route = routeOf(id);
      return route === null ? EMPTY_ACCESS_WORK : pointWork({ route, id }, publicStateBytes, false);
    }),
  );
}

/** One ReadDecisions eligibility handle: the same points as related-read verify, declared once for the page. */
export function relatedReadDecisionEligibility(): ReadDecisionEligibility {
  const receipts = new WeakMap<object, AccessWork>();
  const eligibility: ReadDecisionEligibility = async (client, ids) => {
    const result = await relatedReadVisibility(client, ids);
    receipts.set(ids, relatedReadPointWork(ids));
    return result;
  };
  eligibility.work = {
    bound: ({ ids }) => relatedReadPointWork(ids),
    actual: ({ ids }) => {
      const receipt = receipts.get(ids);
      receipts.delete(ids);
      return receipt;
    },
  };
  return eligibility;
}

/** Related eligibility needs visibility alone; it never hydrates labels/history. */
export function relatedReadEligibility(
  resource: { route: number; id: string },
  ids: readonly string[],
): ResourceEligibility {
  const batch = [...ids];
  const prepare = measured<Prepare, { ids: string[] }>(
    () => EMPTY_ACCESS_WORK,
    async () => ({ value: { ids: batch }, usage: EMPTY_ACCESS_WORK }),
  );
  const verify = measured<Verify<{ ids: string[] }>, boolean>(
    ({ resource }) => (batch.includes(resource.id) ? pointWork(resource, publicStateBytes, false) : EMPTY_ACCESS_WORK),
    async ({ client, resource: identity }) => {
      if (batch.length > 256) throw new TypeError('A related read accepts at most 256 ids');
      if (!batch.includes(identity.id)) return { value: false, usage: EMPTY_ACCESS_WORK };
      const current = await publicState(client, identity, false);
      return { value: current.value?.visibility === 'visible', usage: current.usage };
    },
  );
  return createResourcePublicEligibility({
    resource,
    action: 'subject:read',
    work: { prepare: prepare.producer, verify: verify.producer },
    prepare: prepare.run,
    verify: verify.run,
  });
}

export function subjectReadEligibility(
  resource: { route: number; id: string },
  action = 'subject:read',
): ResourceEligibility {
  const prepare = measured<Prepare, PublicState>(
    ({ resource }) => pointWork(resource, publicStateBytes, true),
    ({ pool, resource }) => withConnection(pool, (client) => publicState(client, resource, true)),
  );
  const verify = measured<Verify<PublicState>, boolean>(
    ({ resource, evidence }) =>
      evidence?.visibility === 'visible' ? pointWork(resource, publicStateBytes, false) : EMPTY_ACCESS_WORK,
    async ({ client, resource, evidence }) => {
      if (evidence?.visibility !== 'visible') return { value: false, usage: EMPTY_ACCESS_WORK };
      const current = await publicState(client, resource, false);
      return {
        value:
          current.value?.visibility === 'visible' && current.value.security_revision === evidence.security_revision,
        usage: current.usage,
      };
    },
  );
  return createResourcePublicEligibility({
    resource,
    action,
    work: { prepare: prepare.producer, verify: verify.producer },
    prepare: prepare.run,
    verify: verify.run,
  });
}
