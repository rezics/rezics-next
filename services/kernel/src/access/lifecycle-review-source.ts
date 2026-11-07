import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import type { Pool } from 'pg';
import type { AccessClient } from '../request/access.ts';
import { withConnection } from '../database/pool.ts';
import { nativeReceiptKeyCandidates } from '../command/receipt-key.ts';
import type { Partition } from '../partition/partition.ts';
import { derivedId, partitionOf, routeOf } from '../route/route.ts';
import { deadlineClient } from './deadline.ts';
import { PLATFORM_RESOURCE } from './bootstrap-governance.ts';
import {
  committedContinuationDigest,
  continuationEntryDigest,
  type ContinuationEntry,
  type ContinuationSnapshot,
} from './committed-continuations.ts';
import type { LifecycleEffects, LifecycleOriginalResult } from './lifecycle-review-contract.ts';
import { ProblemError } from '../http/problem-error.ts';

const SERVICE_ID = '00000000-0000-8000-8000-000000000001';
const ROOT_NAMESPACE = 'b7c3d1e2-4f50-4a61-8c70-0d1e2f304152';
export const hash = (value: unknown) => createHash('sha256').update(canonicalize(value)!).digest();
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
export const unknownOriginal = (): LifecycleOriginalResult => ({ status: 'unknown' });
export function sameHome(a: Partition, b: Partition) {
  return a.node === b.node && a.epoch === b.epoch && b.writeState === 'active';
}
export async function activeHome(client: AccessClient, route: number) {
  // Same native descriptor, with a finite wire projection; oversized descriptors are unavailable.
  const { rows } = await client.query<Omit<Partition, 'position'> & { position: string }>(
    `SELECT partition_no AS "partitionNo", node, write_state AS "writeState", moved_to AS "movedTo", epoch, position::text
     FROM core.partition WHERE partition_no=$1 AND octet_length(node)<=1024 AND coalesce(octet_length(moved_to),0)<=1024`,
    [partitionOf(route)],
  );
  const home = rows[0];
  if (!home || home.writeState !== 'active') throw new ProblemError('partition_unavailable');
  return { ...home, position: BigInt(home.position) };
}

/** Bounded native receipt API projection: exact primary-key candidates from the real permanent ring.
 * The size predicate runs before private JSON crosses the database boundary. */
export async function receipt(client: AccessClient, route: number, principal: string, kind: string, key: string) {
  const keys = nativeReceiptKeyCandidates(client, kind, principal, key);
  const { rows } = await client.query<{
    digest: Buffer;
    epoch: number;
    position: string;
    transactionId: string;
    response: unknown;
  }>(
    `SELECT request_digest AS digest, epoch, position::text, transaction_id AS "transactionId", response
      FROM core.receipt
      WHERE partition_no=$1 AND principal_kind='account' AND principal_id=$2
        AND command_kind=$3 AND idempotency_key=ANY($4::text[])
        AND payload_state='present' AND octet_length(response::text)<=2048 LIMIT 1`,
    [partitionOf(route), principal, kind, keys],
  );
  return rows[0];
}

/** Inspects one immutable native page, never runs its runner. Further pages remain an explicit liability. */
async function operatorEffects(
  pool: Pool,
  deadline: number,
  root: ContinuationSnapshot,
  requestedPageKey?: string,
): Promise<Pick<LifecycleEffects, 'operator' | 'inspectedPages' | 'terminalSubjects' | 'operatorPage'>> {
  const lifting = root.allowlist.some((e) => e.step === 'operator-fence-source');
  const step = lifting ? 'operator-unfence-page' : 'operator-responsibility-page';
  const pageKey = requestedPageKey ?? createHash('sha256').update('first').digest('hex');
  const pageEntry = requestedPageKey
    ? await withConnection(pool, async (connection) => {
        const client = deadlineClient(connection, deadline);
        await activeHome(client, root.route);
        const { rows } = await client.query<ContinuationEntry>(
          `SELECT step,target,key,digest FROM access.committed_continuation_entry
       WHERE route=$1 AND continuation_id=$2 AND step=$3 AND target=$4 AND key=$5`,
          [root.route, root.continuationId, step, root.accountId, `${root.commandKeyPrefix}:page:${pageKey}`],
        );
        return rows[0];
      })
    : root.allowlist.find((e) => e.step === step);
  const unavailable = { operator: 'unknown', inspectedPages: 0, terminalSubjects: 0 } as const;
  if (
    !pageEntry ||
    pageEntry.target !== root.accountId ||
    pageEntry.digest !== continuationEntryDigest(pageEntry) ||
    pageEntry.key !==
      (requestedPageKey ? `${root.commandKeyPrefix}:page:${pageKey}` : `${root.commandKeyPrefix}:${step}`)
  )
    return unavailable;
  const native = await withConnection(pool, async (connection) => {
    const client = deadlineClient(connection, deadline);
    const home = await activeHome(client, root.route);
    const { rows } = await client.query<{ cursor: string | null; next: string | null; entries: ContinuationEntry[] }>(
      `SELECT cursor, next_cursor AS next, allowlist AS entries FROM access.operator_fence_page
       WHERE route=$1 AND continuation_id=$2 AND page_key=$3
         AND octet_length(allowlist::text)<=65536 AND coalesce(octet_length(cursor),0)<=8192
         AND coalesce(octet_length(next_cursor),0)<=8192`,
      [root.route, root.continuationId, pageKey],
    );
    return { home, page: rows[0] };
  });
  const page = native.page;
  if (
    !page ||
    createHash('sha256')
      .update(page.cursor ?? 'first')
      .digest('hex') !== pageKey ||
    !Array.isArray(page.entries) ||
    page.entries.length > 101 ||
    page.entries.some((e) => e.digest !== continuationEntryDigest(e))
  )
    return unavailable;
  const children = page.entries.filter((e) => e.step === (lifting ? 'unfence' : 'fence'));
  if (children.length > 100 || children.length + (page.next ? 1 : 0) !== page.entries.length) return unavailable;
  if (page.next) {
    const nextKey = createHash('sha256').update(page.next).digest('hex');
    if (
      !page.entries.some(
        (e) => e.step === step && e.target === root.accountId && e.key === `${root.commandKeyPrefix}:page:${nextKey}`,
      )
    )
      return unavailable;
  }
  // Completion membership alone is not evidence: corroborate each exact business receipt and immutable digest.
  async function terminal(
    entry: ContinuationEntry,
    route: number,
    id: string,
    kind: string,
    input: unknown,
    valid: (v: Record<string, unknown>) => boolean,
  ) {
    const digest = hash([
      route,
      id,
      kind,
      { actorAccountId: SERVICE_ID, clientId: 'internal-access', requestedBy: null },
      input,
    ]);
    const rawKey = `${route}:${entry.key}`;
    const completion = await withConnection(pool, async (connection) => {
      const client = deadlineClient(connection, deadline);
      const home = await activeHome(client, root.route);
      if (!sameHome(native.home, home)) return undefined;
      const { rows } = await client.query<{
        digest: string;
        receiptKey: string | null;
        receiptDigest: string | null;
        receiptId: string;
      }>(
        `SELECT digest, receipt_key AS "receiptKey", receipt_digest AS "receiptDigest", receipt_id AS "receiptId"
         FROM access.committed_continuation_completion
         WHERE route=$1 AND continuation_id=$2 AND step=$3 AND target=$4 AND key=$5`,
        [root.route, root.continuationId, entry.step, entry.target, entry.key],
      );
      return rows[0];
    });
    if (
      !completion ||
      completion.digest !== entry.digest ||
      completion.receiptKey !== rawKey ||
      completion.receiptDigest !== digest.toString('hex')
    )
      return false;
    // No source connection is held while inspecting a different subject's home.
    return withConnection(pool, async (connection) => {
      const client = deadlineClient(connection, deadline);
      const home = await activeHome(client, route);
      const row = await receipt(client, route, SERVICE_ID, `access.${kind}`, rawKey);
      if (
        !row ||
        row.epoch > home.epoch ||
        BigInt(row.position) > home.position ||
        !row.digest.equals(digest) ||
        !object(row.response) ||
        !valid(row.response)
      )
        return false;
      const expectedId =
        !lifting && row.response.fenced === true
          ? derivedId('134e9749-1120-8a0c-97d0-71287a629cef', `${row.transactionId}:fence`, route)
          : row.transactionId;
      return completion.receiptId === expectedId && sameHome(home, await activeHome(client, route));
    });
  }
  if (
    !(await terminal(
      pageEntry,
      root.route,
      root.accountId,
      lifting ? 'operator.unfence-page' : 'operator.fence-page',
      { continuationId: root.continuationId, cursor: page.cursor },
      (v) => v.pageKey === pageKey && v.count === children.length,
    ))
  )
    return unavailable;
  let terminalSubjects = 0;
  for (const child of children) {
    const [subjectAccountId, reservationId, extra] = child.target.split(':');
    const route = subjectAccountId ? routeOf(subjectAccountId) : null;
    if (
      route === null ||
      !reservationId ||
      routeOf(reservationId) === null ||
      extra ||
      child.key !== `${root.commandKeyPrefix}:${lifting ? 'unfence' : 'fence'}:${reservationId}`
    )
      return unavailable;
    const input = lifting
      ? { continuationId: root.continuationId, subjectAccountId, reservationId }
      : { operatorAccountId: root.accountId, subjectAccountId, reservationId, key: child.key };
    if (
      await terminal(
        child,
        route,
        subjectAccountId!,
        lifting ? 'operator.subject-unfenced' : 'operator.subject-fenced',
        input,
        (v) => v.accountId === subjectAccountId && typeof v[lifting ? 'lifted' : 'fenced'] === 'boolean',
      )
    )
      terminalSubjects++;
  }
  const complete = terminalSubjects === children.length;
  return {
    operator: page.cursor === null && !page.next && complete ? 'complete' : 'pending',
    inspectedPages: 1,
    terminalSubjects,
    operatorPage: {
      state: complete ? 'complete' : 'pending',
      nextPageKey: page.next ? createHash('sha256').update(page.next).digest('hex') : null,
    },
  };
}

export async function originalResult(
  client: AccessClient,
  input: {
    route: number;
    accountId: string;
    principal: string;
    operationId: 'account.suspend' | 'account.reinstate';
    key: string;
    digest: Buffer;
  },
) {
  const home = await activeHome(client, input.route);
  const row = await receipt(client, input.route, input.principal, `access.${input.operationId}`, input.key);
  if (
    !row ||
    !row.digest.equals(input.digest) ||
    row.epoch > home.epoch ||
    BigInt(row.position) > home.position ||
    !object(row.response)
  )
    return null;
  const value = row.response;
  const suspension = input.operationId === 'account.suspend';
  const receiptId = derivedId(
    PLATFORM_RESOURCE.id,
    `${row.transactionId}:${suspension ? 'suspension' : 'reinstatement'}`,
    input.route,
  );
  if (
    value.accountId !== input.accountId ||
    value.receiptId !== receiptId ||
    value.state !== (suspension ? 'suspended' : 'active') ||
    typeof value.minimumAuthnEpoch !== 'string' ||
    !/^[1-9][0-9]{0,18}$/.test(value.minimumAuthnEpoch)
  )
    return null;
  // Event zero is written atomically by these exact commands, and distinguishes a committed no-fanout case.
  const { rows } = await client.query<{ data: Record<string, unknown> }>(
    `SELECT data FROM core.outbox WHERE partition_no=$1 AND position=$2 AND event_seq=0 AND epoch=$3
      AND type=$4 AND subject=$5 AND payload_state='present' AND octet_length(data::text)<=2048`,
    [
      partitionOf(input.route),
      row.position,
      row.epoch,
      `com.rezics.access.account.${suspension ? 'suspended' : 'reinstated'}.v1`,
      input.accountId,
    ],
  );
  const event = rows[0]?.data;
  if (
    !event ||
    event.accountId !== input.accountId ||
    event.receiptId !== receiptId ||
    event.state !== value.state ||
    event.minimumAuthnEpoch !== value.minimumAuthnEpoch
  )
    return { receiptId, root: null, noFanout: false };
  const operationKey = `${suspension ? 'suspend' : 'reinstate'}:${receiptId}`;
  if (event.continuationOperationKey === undefined)
    return { receiptId, root: null, noFanout: !suspension || value.continuationOperationKey === undefined };
  if (
    event.continuationOperationKey !== operationKey ||
    (suspension && value.continuationOperationKey !== operationKey)
  )
    return { receiptId, root: null, noFanout: false };
  const continuationId = derivedId(ROOT_NAMESPACE, `${input.accountId}:${operationKey}`, input.route);
  const roots = await client.query<{ snapshot: ContinuationSnapshot; digest: string }>(
    `SELECT jsonb_build_object('route',route,'continuationId',continuation_id,'accountId',account_id,
      'operationKey',operation_key,'operationDigest',operation_digest,'commandKeyPrefix',command_key_prefix,
      'barrierReceiptId',barrier_receipt_id,'barrierTransactionId',barrier_transaction_id,
      'minimumAuthnEpoch',minimum_authn_epoch::text,'priorHandle',prior_handle,
      'priorOperatorAccountId',prior_operator_account_id,'priorReservationId',prior_reservation_id,
      'allowlist',allowlist,'createdAt',to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'committedExpiresAt',to_char(committed_expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) AS snapshot, digest
     FROM access.committed_continuation WHERE route=$1 AND continuation_id=$2 AND octet_length(allowlist::text)<=4096`,
    [input.route, continuationId],
  );
  const root = roots.rows[0];
  const valid =
    root &&
    committedContinuationDigest(root.snapshot) === root.digest &&
    root.snapshot.accountId === input.accountId &&
    root.snapshot.barrierReceiptId === receiptId &&
    root.snapshot.barrierTransactionId === row.transactionId &&
    root.snapshot.minimumAuthnEpoch === value.minimumAuthnEpoch &&
    root.snapshot.operationDigest === input.digest.toString('hex') &&
    root.snapshot.commandKeyPrefix === `wf:${createHash('sha256').update(receiptId).digest('hex')}` &&
    Array.isArray(root.snapshot.allowlist) &&
    root.snapshot.allowlist.length <= 4 &&
    root.snapshot.allowlist.every((e) => e.digest === continuationEntryDigest(e));
  return { receiptId, root: valid ? root.snapshot : null, noFanout: false };
}

/** This is only Access's permission to reach Auth's step, never Auth's deletion result. */
async function sessionAuthorization(
  pool: Pool,
  deadline: number,
  root: ContinuationSnapshot,
): Promise<'recorded' | 'unknown'> {
  const entry = root.allowlist.find((e) => e.step === 'revoke-auth-sessions' && e.target === root.accountId);
  if (!entry || entry.key !== `${root.commandKeyPrefix}:revoke-auth-sessions`) return 'unknown';
  const key = `${root.route}:committed:${entry.key}`;
  const digest = hash([
    root.route,
    root.continuationId,
    'cleanup-continuation.recorded',
    { actorAccountId: SERVICE_ID, clientId: 'internal-access', requestedBy: null },
    {
      continuationId: root.continuationId,
      step: entry.step,
      target: entry.target,
      key: entry.key,
      digest: entry.digest,
    },
  ]);
  return withConnection(pool, async (connection) => {
    const client = deadlineClient(connection, deadline);
    const home = await activeHome(client, root.route);
    const { rows } = await client.query<{
      digest: string;
      receiptKey: string;
      receiptDigest: string;
      receiptId: string;
    }>(
      `SELECT digest, receipt_key AS "receiptKey", receipt_digest AS "receiptDigest", receipt_id AS "receiptId"
       FROM access.committed_continuation_completion
       WHERE route=$1 AND continuation_id=$2 AND step=$3 AND target=$4 AND key=$5`,
      [root.route, root.continuationId, entry.step, entry.target, entry.key],
    );
    const completion = rows[0];
    if (
      !completion ||
      completion.digest !== entry.digest ||
      completion.receiptKey !== key ||
      completion.receiptDigest !== digest.toString('hex')
    )
      return 'unknown';
    const row = await receipt(client, root.route, SERVICE_ID, 'access.cleanup-continuation.recorded', key);
    if (
      !row ||
      !row.digest.equals(digest) ||
      row.epoch > home.epoch ||
      BigInt(row.position) > home.position ||
      !object(row.response) ||
      row.response.continuationId !== root.continuationId ||
      row.response.receiptId !== row.transactionId ||
      completion.receiptId !== row.transactionId ||
      !sameHome(home, await activeHome(client, root.route))
    )
      return 'unknown';
    return 'recorded';
  });
}

export async function effects(
  pool: Pool,
  deadline: number,
  suspension: boolean,
  source: NonNullable<Awaited<ReturnType<typeof originalResult>>>,
  requestedPageKey?: string,
): Promise<LifecycleEffects> {
  let operator: Pick<LifecycleEffects, 'operator' | 'inspectedPages' | 'terminalSubjects' | 'operatorPage'>;
  try {
    operator = source.noFanout
      ? ({ operator: 'complete', inspectedPages: 0, terminalSubjects: 0 } as const)
      : source.root
        ? await operatorEffects(pool, deadline, source.root, requestedPageKey)
        : ({ operator: 'unknown', inspectedPages: 0, terminalSubjects: 0 } as const);
  } catch {
    // A missing foreign home refuses only its dependent terminal claim, never erases the original receipt.
    operator = { operator: 'unknown', inspectedPages: 0, terminalSubjects: 0 };
  }
  let sessionRevocationAuthorization: LifecycleEffects['sessionRevocationAuthorization'] = 'not_required';
  if (suspension) {
    sessionRevocationAuthorization = 'unknown';
    if (source.noFanout) sessionRevocationAuthorization = 'not_required';
    else if (source.root) {
      try {
        sessionRevocationAuthorization = await sessionAuthorization(pool, deadline, source.root);
      } catch {
        /* Dependent proof unavailable. */
      }
    }
  }
  // Neither Auth cleanup nor Semantic account_agent delivery has an original-bound terminal operand here.
  // Owned operator proofs remain useful without manufacturing a foreign ACK or whole-effect completion.
  return {
    ...operator,
    sessionRevocationAuthorization,
    sessionRevocation: suspension ? 'unknown' : 'not_required',
    accountAgentSynchronization: 'unknown',
    state: operator.operator === 'pending' ? 'pending' : 'unknown',
  };
}
