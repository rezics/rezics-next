import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { discardConnection, withConnection, withQueryAccounting } from '../database/pool.ts';
import { withBoundedReadLifetime } from '../database/bounded-read-lifetime.ts';
import { deadlineFor, withRequestDeadline } from '../request/deadline.ts';
import { lookupEventType } from '../events/catalogue.ts';
import { REVIEW_DISCOVERY_CHANGED } from '../content/review-discovery-events.ts';
import { readReviewDiscoveryChanges, refreshReviewDiscoveryChanges, withReadTransaction } from './native-bindings.ts';
import type { ReviewDiscoverySource } from '../content/review-discovery.ts';
import { discoveryGenerations } from './generations.ts';
import { withDiscoveryTarget, type DiscoveryProjection, type DiscoveryTarget } from './account-discovery.ts';

/** Increment when the installed native read/Format2 projection meaning changes. */
export const REVIEW_RECEIVING_MEANING = 'content-review-current-format2-v1';
export const REVIEW_RECEIVING_BATCH = 100;
const turnBudgetMs = 30_000;
const maxPosition = 9_223_372_036_854_775_807n;
const targetWhere = 'prefix=$1 AND generation=$2 AND index_uuid=$3 AND incarnation=$4 AND meaning=$5';
const where = `${targetWhere} AND partition_no=$6`;
const parameters = (target: DiscoveryTarget) => [
  target.prefix,
  target.generation,
  target.uuid,
  target.incarnation,
  REVIEW_RECEIVING_MEANING,
];
function partition(value: number) {
  if (!Number.isInteger(value) || value < 0 || value > 4095) throw new RangeError('Invalid receiving partition');
}

export type ReviewReceivingContext = Readonly<{ deadline: number }>;

export class ReviewReceivingDeadlineError extends Error {
  constructor() {
    super('Review discovery receiving deadline expired');
    this.name = 'ReviewReceivingDeadlineError';
  }
}

function remaining(deadline: number) {
  const milliseconds = deadline - Date.now();
  if (!Number.isFinite(deadline) || milliseconds <= 0) throw new ReviewReceivingDeadlineError();
  return Math.max(1, Math.floor(milliseconds));
}

/** Late owner completions cannot resume receiving. Their request context keeps the original deadline. */
async function within<T>(deadline: number, work: () => Promise<T>): Promise<T> {
  remaining(deadline);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve()
        .then(() => {
          remaining(deadline);
          return withRequestDeadline(deadline, work);
        })
        .then((value) => {
          remaining(deadline);
          return value;
        }),
      new Promise<never>((_, reject) => {
        const expire = () => {
          const milliseconds = deadline - Date.now();
          if (milliseconds > 0) timer = setTimeout(expire, Math.max(1, Math.ceil(milliseconds)));
          else reject(new ReviewReceivingDeadlineError());
        };
        timer = setTimeout(expire, Math.max(1, Math.ceil(deadline - Date.now())));
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function turn<T>(context: ReviewReceivingContext | undefined, work: (deadline: number) => Promise<T>): Promise<T> {
  if (context && !Number.isFinite(context.deadline)) throw new TypeError('Invalid review receiving deadline');
  const deadline = Math.min(Date.now() + turnBudgetMs, deadlineFor(turnBudgetMs), context?.deadline ?? Infinity);
  // Every stage enforces this deadline. Await their terminal cleanup instead of racing the whole turn.
  return withRequestDeadline(deadline, async () => {
    remaining(deadline);
    try {
      const value = await work(deadline);
      remaining(deadline);
      return value;
    } catch (error) {
      remaining(deadline);
      throw error;
    }
  });
}

/** Writable checkout, not a read snapshot. Only a completely cleaned session may return to the pool. */
async function connection<T>(
  pool: Pool,
  deadline: number,
  work: (client: PoolClient) => Promise<T>,
  unsettledTarget?: () => Promise<void> | undefined,
): Promise<T> {
  let reusable = false;
  let acquired = false;
  let checkout: Promise<unknown> | undefined;
  const bounded = withBoundedReadLifetime(
    (run) => {
      const operation = withConnection(pool, async (raw) => {
        acquired = true;
        try {
          return await run(raw);
        } finally {
          // This also covers expiry while a manual transaction or advisory session lock is idle.
          if (!reusable) {
            discardConnection(raw, new Error('Review receiving session was not fully released'));
            // Retire SQL immediately, but retain the physical session lock until all target transport
            // (including physical checks and readback) has completed its original-deadline cancellation.
            await unsettledTarget?.()?.catch(() => {});
          }
        }
      });
      checkout = operation;
      return operation;
    },
    discardConnection,
    deadline,
    async (client) => {
      const settings = (
        await client.query<{ statement_timeout: string; lock_timeout: string }>(
          `SELECT current_setting('statement_timeout') AS statement_timeout,
           current_setting('lock_timeout') AS lock_timeout`,
        )
      ).rows[0]!;
      await client.query(`SELECT set_config('statement_timeout',$1,false),set_config('lock_timeout',$1,false)`, [
        `${remaining(deadline)}ms`,
      ]);
      const value = await work(client);
      await client.query(`SELECT set_config('statement_timeout',$1,false),set_config('lock_timeout',$2,false)`, [
        settings.statement_timeout,
        settings.lock_timeout,
      ]);
      reusable = true;
      return value;
    },
    {
      deadlineError: () => new ReviewReceivingDeadlineError(),
      isUncertainSettledQueryError: () => true,
    },
  );
  try {
    return await bounded;
  } finally {
    // The bounded client can retire before its checkout callback finishes terminal transport cleanup.
    // A still-queued acquisition owns no session; the lifetime retires it before any late SQL dispatch.
    if (acquired) await checkout?.catch(() => {});
  }
}

/** Adapt only Search's withConnection helpers to this owned checkout. Never pass this to native owners. */
function onSession<T>(pool: Pool, client: PoolClient, work: (session: Pool) => Promise<T>): Promise<T> {
  const borrowed = Object.create(client) as PoolClient;
  // The outer lifetime restores or discards the physical client, including on helper cleanup failure.
  borrowed.release = () => {};
  const session = Object.create(pool) as Pool;
  let checkedOut = false;
  session.connect = (async () => {
    if (checkedOut) throw new Error('Review receiving session was already checked out');
    checkedOut = true;
    return borrowed;
  }) as Pool['connect'];
  // The physical checkout already accounts every query. Borrowing it is not another checkout/query cost.
  return withQueryAccounting(
    { connection: (dispatch) => dispatch(), query: (_sql, _operands, dispatch) => dispatch() },
    () => work(session),
  );
}

type Stored = {
  acknowledged: string;
  requested: string;
  through: string | null;
  completed_cut: string;
  native_position: string | null;
  status: 'preparing' | 'ready' | 'unavailable';
  claim: string | null;
};
export type ReviewReceivingFrontier = Readonly<{
  target: DiscoveryTarget;
  meaning: typeof REVIEW_RECEIVING_MEANING;
  partition: number;
  status: 'preparing' | 'ready' | 'unavailable';
  acknowledged: bigint;
  requested: bigint;
  /** Incomplete fixed pass, or null after its final visible application. */
  through: bigint | null;
  completedCut: bigint;
  nativePosition: bigint | null;
}>;

/** Exact partition readiness only. Never a population, upstream-dispatch or disclosure certificate. */
export async function readReviewDiscoveryReceiving(
  pool: Pool,
  target: DiscoveryTarget,
  home: number,
  context?: ReviewReceivingContext,
): Promise<ReviewReceivingFrontier> {
  partition(home);
  return turn(context, (deadline) => connection(pool, deadline, (client) => read(client, target, home)));
}

async function read(client: PoolClient, target: DiscoveryTarget, home: number): Promise<ReviewReceivingFrontier> {
  const row = (
    await client.query<Stored>(
      `SELECT acknowledged::text,requested::text,through::text,completed_cut::text,native_position::text,status,claim
     FROM search.review_discovery_receiving WHERE ${where}`,
      [...parameters(target), home],
    )
  ).rows[0];
  return {
    target: { ...target },
    meaning: REVIEW_RECEIVING_MEANING,
    partition: home,
    status: row?.status ?? 'preparing',
    acknowledged: BigInt(row?.acknowledged ?? 0),
    requested: BigInt(row?.requested ?? 0),
    through: row?.through === null || !row ? null : BigInt(row.through),
    completedCut: BigInt(row?.completed_cut ?? 0),
    nativePosition: row?.native_position === null || !row ? null : BigInt(row.native_position),
  };
}

async function ensure(client: PoolClient, target: DiscoveryTarget, home: number) {
  await client.query(
    `INSERT INTO search.review_discovery_receiving(prefix,generation,index_uuid,incarnation,meaning,partition_no)
     VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
    [...parameters(target), home],
  );
}

/** Events carry identities/original provenance, never an index body or a Content revision ordering. */
export async function requestReviewDiscoveryReceiving(
  pool: Pool,
  prefix: string,
  data: unknown,
  context?: ReviewReceivingContext,
): Promise<void> {
  if (!lookupEventType(REVIEW_DISCOVERY_CHANGED)?.Check(data)) throw new TypeError('Invalid review receiving wakeup');
  const wake = data as { partition: number; through: string };
  if (BigInt(wake.through) > maxPosition) throw new RangeError('Review receiving wakeup exceeds native position');
  return turn(context, (deadline) =>
    connection(pool, deadline, async (client) => {
      const targets = await onSession(pool, client, (session) => discoveryGenerations(session, prefix));
      for (const target of targets) {
        if (!target.uuid || ['retired', 'retiring', 'quarantined', 'allocated'].includes(target.state)) continue;
        await ensure(client, target, wake.partition);
        await client.query(
          `UPDATE search.review_discovery_receiving SET requested=GREATEST(requested,$7::bigint),
           pending=pending OR $7::bigint>acknowledged,
           status=CASE WHEN $7::bigint>acknowledged THEN 'preparing' ELSE status END WHERE ${where}`,
          [...parameters(target), wake.partition, wake.through],
        );
      }
    }),
  );
}

const encode = (value: unknown) =>
  JSON.stringify(value, (_, item) => (typeof item === 'bigint' ? item.toString() : item));

/** One admitted deadline and page. A short claim releases the checkout before native refresh (including max=1 pools).
 * Target session custody then fences staging, index application, visible observation and acknowledged progress.
 * Receiving mutations require a live claim; uncertain external projection never acknowledges progress.
 */
export function createReviewDiscoveryReceiving(options: {
  pool: Pool;
  search: Parameters<typeof withDiscoveryTarget>[1];
  projection: DiscoveryProjection;
  source?: ReviewDiscoverySource;
  batchSize?: number;
}) {
  const { pool, search, projection, source } = options;
  const target = projection.target;
  const batch = options.batchSize ?? REVIEW_RECEIVING_BATCH;
  if (!Number.isInteger(batch) || batch < 1 || batch > 100) throw new RangeError('Invalid review receiving page limit');

  async function step(home: number, context?: ReviewReceivingContext): Promise<ReviewReceivingFrontier> {
    partition(home);
    return turn(context, (deadline) => receive(home, deadline));
  }

  async function receive(home: number, deadline: number): Promise<ReviewReceivingFrontier> {
    const projectionContext = { deadline };
    const values = [...parameters(target), home];
    const claim = randomUUID();
    let attempted = false;
    const frontier = () => connection(pool, deadline, (client) => read(client, target, home));
    try {
      const claimed = await connection(pool, deadline, async (client) => {
        await ensure(client, target, home);
        attempted = true;
        return (
          await client.query<Stored>(
            `UPDATE search.review_discovery_receiving
             SET claim=$7,claim_until=statement_timestamp()+$8::double precision*interval '1 millisecond',
             pending=true,status='preparing' WHERE ${where}
             AND (claim IS NULL OR claim_until<=clock_timestamp())
             AND statement_timestamp()+$8::double precision*interval '1 millisecond'>clock_timestamp()
             RETURNING acknowledged::text,requested::text,through::text,completed_cut::text,native_position::text,status,claim`,
            [...values, claim, remaining(deadline)],
          )
        ).rows[0];
      });
      if (!claimed) return await frontier();
      if (!source) throw new Error('Native review receiving source is unavailable');
      // Recover by reading current native rows again. A staged body is never a refresh cache.
      // The nested native callable sees its original Pool and this short, shared-deadline snapshot.
      const page = await within(deadline, () =>
        withReadTransaction(
          pool,
          () =>
            readReviewDiscoveryChanges(
              pool,
              home,
              BigInt(claimed.acknowledged),
              batch,
              claimed.through === null ? undefined : BigInt(claimed.through),
            ),
          deadline,
        ),
      );
      const unchanged =
        claimed.through === null &&
        page.next === null &&
        page.changes.length === 0 &&
        page.after === BigInt(claimed.acknowledged) &&
        page.through === page.after;
      const retainedThrough = unchanged ? null : page.through.toString();
      // An unchanged journal cut has no cursor or actions to stage. Acknowledge it under the same target
      // custody and live-claim CAS, including any wakeup recorded since the claim.
      if (!unchanged) {
        const retained = await connection(pool, deadline, (client) =>
          client.query(
            `UPDATE search.review_discovery_receiving SET through=$8,stage=$9::jsonb WHERE ${where}
             AND claim=$7 AND claim_until>clock_timestamp() AND acknowledged=$10::bigint
             AND (through IS NULL OR through=$8::bigint)`,
            [...values, claim, page.through.toString(), encode({ page }), claimed.acknowledged],
          ),
        );
        if (retained.rowCount !== 1) throw new Error('Review receiving claim was superseded or expired');
      }
      const ids = [...new Set(page.changes.map((change) => change.id))];
      const refreshed = ids.length
        ? await within(deadline, () => refreshReviewDiscoveryChanges(source, page))
        : undefined;
      const actions = refreshed ? await projection.prepareReviews(refreshed, ids, projectionContext) : [];
      let publishing: Promise<void> | undefined;
      const apply = async (client: PoolClient, index: string) => {
        if (!unchanged) {
          const admitted = await client.query(
            `UPDATE search.review_discovery_receiving SET stage=$8::jsonb WHERE ${where}
             AND claim=$7 AND claim_until>clock_timestamp() AND acknowledged=$9::bigint AND through=$10::bigint
             AND ($11::bigint IS NULL OR native_position IS NULL OR native_position<=$11::bigint)`,
            [
              ...values,
              claim,
              encode({ page, actions, nativePosition: refreshed?.nativePosition ?? null }),
              claimed.acknowledged,
              page.through.toString(),
              refreshed?.nativePosition.toString() ?? null,
            ],
          );
          if (admitted.rowCount !== 1)
            throw new Error('Review receiving claim or native observation is no longer current');
        }
        await projection.applyReviews(actions, {
          client,
          index,
          context: projectionContext,
          async acknowledge() {
            remaining(deadline);
            // Copy settlement and receiving frontier commit in the same PostgreSQL transaction,
            // only after the exact engine effects have become visible. A lost response repeats refresh.
            const result = await client.query(
              `UPDATE search.review_discovery_receiving SET acknowledged=$8,
                 through=$9,completed_cut=CASE WHEN $9::bigint IS NULL THEN $10 ELSE completed_cut END,
                 native_position=COALESCE($11::bigint,native_position),stage=NULL,
                 pending=($9::bigint IS NOT NULL OR requested>$8::bigint),
                 status=CASE WHEN $9::bigint IS NOT NULL OR requested>$8::bigint THEN 'preparing' ELSE 'ready' END,
                 claim=NULL,claim_until=NULL WHERE ${where} AND claim=$7 AND claim_until>clock_timestamp()
                 AND acknowledged=$12::bigint AND through IS NOT DISTINCT FROM $13::bigint
                 AND ($11::bigint IS NULL OR native_position IS NULL OR native_position<=$11::bigint)`,
              [
                ...values,
                claim,
                page.after.toString(),
                page.next === null ? null : page.through.toString(),
                page.through.toString(),
                refreshed?.nativePosition.toString() ?? null,
                claimed.acknowledged,
                retainedThrough,
              ],
            );
            if (result.rowCount !== 1) throw new Error('Review receiving acknowledgement lost its claim');
          },
        });
      };
      return await connection(
        pool,
        deadline,
        async (owned) => {
          publishing = onSession(pool, owned, (session) =>
            withDiscoveryTarget(session, search, target, apply, false, projectionContext),
          );
          await publishing;
          // Custody and its post-validation have ended. Read the current frontier in a fresh statement
          // on this still-bounded checkout, including any wakeup committed since acknowledgement.
          return read(owned, target, home);
        },
        () => publishing,
      );
    } catch (error) {
      if (attempted && Date.now() < deadline) {
        try {
          await connection(pool, deadline, (client) =>
            client.query(
              `UPDATE search.review_discovery_receiving SET status='unavailable',pending=true,claim=NULL,claim_until=NULL
               WHERE ${where} AND claim=$7`,
              [...values, claim],
            ),
          );
        } catch {
          // No new cleanup budget. The bounded session is retired and the durable claim expires.
        }
      }
      throw error;
    }
  }

  /** Fair indexed pending seeks, with a fixed 4096-partition sweep for restart and missed wakeups.
   * The existing supervisor calls this once per live target; there is no second poller or drain loop.
   */
  async function next(context?: ReviewReceivingContext) {
    return turn(context, async (deadline) => {
      const values = parameters(target);
      const home = await connection(pool, deadline, async (client) => {
        await client.query(
          `INSERT INTO search.review_discovery_receiving_scan(prefix,generation,index_uuid,incarnation,meaning)
           VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
          values,
        );
        const cursor = (
          await client.query<{ partition_no: number }>(
            `SELECT partition_no FROM search.review_discovery_receiving_scan WHERE ${targetWhere}`,
            values,
          )
        ).rows[0]!.partition_no;
        let due: number | undefined;
        // Two keyset seeks implement wraparound, both bounded by the fixed native partition domain.
        for (const after of [cursor, 0]) {
          const selected = (
            await client.query<{ partition_no: number }>(
              `SELECT partition_no FROM search.review_discovery_receiving WHERE ${targetWhere}
               AND pending AND partition_no>=$6 AND (claim IS NULL OR claim_until<=clock_timestamp())
               ORDER BY partition_no LIMIT 1`,
              [...values, after],
            )
          ).rows[0];
          if (selected) {
            due = selected.partition_no;
            break;
          }
        }
        const selected = due ?? cursor;
        await client.query(`UPDATE search.review_discovery_receiving_scan SET partition_no=$6 WHERE ${targetWhere}`, [
          ...values,
          (selected + 1) % 4096,
        ]);
        return selected;
      });
      return receive(home, deadline);
    });
  }
  return {
    step,
    next,
    status: (home: number, context?: ReviewReceivingContext) =>
      readReviewDiscoveryReceiving(pool, target, home, context),
  };
}
