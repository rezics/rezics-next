import type { Pool } from 'pg';
import { Value } from 'typebox/value';
import { deadlineClient } from '../access/authenticate.ts';
import { AccessUnavailableError, requireAccessDeadline } from '../access/unavailable.ts';
import { type CommandTransaction, DEFAULT_REQUEST_DEADLINE_MS, noEffect, runCommand } from '../command/command.ts';
import { withBoundedReadConnection } from '../database/pool.ts';
import type { Effect } from '../events/effects.ts';
import type { CloudEvent } from '../events/log.ts';
import {
  CANONICAL_GENERATION_COMMITTED,
  CANONICAL_GENERATION_CONTINUATION,
  CANONICAL_GENERATION_DELIVERED,
  CANONICAL_GENERATION_REBUILD_CONTINUED,
  SEMANTIC_EVENTS,
} from './events.ts';

export const CANONICAL_GENERATION_PAGE_SIZE = 200;
const CANONICAL_GENERATION_SOURCE_BATCH_SIZE = 8;
const contextDirectoryChanged = 'com.rezics.semantic.context-directory.changed.v1';
export type CanonicalGenerationDelivery = Readonly<{ partition: number; generation: string }>;
export type CanonicalGenerationPageRequest = Readonly<{ after: number | null; limit: number; unannouncedOnly?: true }>;
export type CanonicalGenerationReceiver = (
  tx: CommandTransaction,
  generation: CanonicalGenerationDelivery,
  event: CloudEvent,
) => Promise<
  Readonly<{
    partition: number;
    canonicalGeneration: string;
    revision: string;
    complete: boolean;
  }>
>;

const maximumSerial = 9223372036854775807n;
function validGeneration(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= maximumSerial;
}

function copyPage(input: CanonicalGenerationPageRequest): CanonicalGenerationPageRequest {
  const { after, limit } = input;
  if (
    (after !== null && (!Number.isInteger(after) || after < 0 || after > 4095)) ||
    !Number.isInteger(limit) || limit < 1 || limit > CANONICAL_GENERATION_PAGE_SIZE
  )
    throw new TypeError('Invalid canonical generation delivery page');
  return { after, limit, ...(input.unannouncedOnly === true && { unannouncedOnly: true as const }) };
}

function nativeHome(event: CloudEvent): number {
  const source = /^urn:rezics:log:(0|[1-9][0-9]*)\.([1-9][0-9]*)$/.exec(event.source);
  const partition = Number(source?.[1]);
  const epoch = Number(source?.[2]);
  if (
    !source || !Number.isInteger(partition) || partition < 0 || partition > 4095 ||
    !Number.isInteger(epoch) || epoch < 1 || epoch > 2147483647 ||
    !/^[0-9]{19}$/.test(event.sequence) || BigInt(event.sequence) < 1n ||
    BigInt(event.sequence) > maximumSerial
  )
    throw new TypeError('Invalid native canonical generation envelope');
  return partition;
}

/** One keyset seek over the existing <=4096 home counters, including retained empty homes.
 * This is delivery inventory, not a second name/population observer or a coverage certificate.
 * The connection is released before the caller starts any command or foreign work.
 */
export async function readCanonicalGenerationDeliveryPage(
  pool: Pool,
  input: CanonicalGenerationPageRequest,
  { deadline }: Readonly<{ deadline: number }>,
): Promise<Readonly<{ homes: readonly CanonicalGenerationDelivery[]; after: number | null }>> {
  const { after, limit, unannouncedOnly } = copyPage(input);
  requireAccessDeadline(deadline);
  const result = await withBoundedReadConnection(
    pool,
    deadline,
    (client) => deadlineClient(client, deadline).query<CanonicalGenerationDelivery>(
      `SELECT partition_no AS partition,canonical_generation::text AS generation
       FROM semantic.partition_subjects
       WHERE partition_no>$1 AND canonical_delivered_generation<canonical_generation
         ${unannouncedOnly ? 'AND canonical_announced_generation<canonical_generation' : ''}
       ORDER BY partition_no LIMIT $2`,
      [after ?? -1, limit],
    ),
    { deadlineError: () => new AccessUnavailableError('deadline') },
  );
  requireAccessDeadline(deadline);
  for (const [index, home] of result.rows.entries()) {
    if (
      !Number.isInteger(home.partition) || home.partition <= (result.rows[index - 1]?.partition ?? after ?? -1) ||
      home.partition > 4095 || !validGeneration(home.generation)
    )
      throw new Error('Invalid committed canonical generation inventory');
  }
  const last = result.rows.at(-1)?.partition;
  return {
    homes: result.rows,
    after: result.rows.length === limit && last !== 4095 ? last! : null,
  };
}

/** Source-only recovery entry. Each emitted notification uses runCommand's real home envelope.
 * The generation is re-read under that command; a sequence increment or an old event cannot
 * supply it. The native log retains the keyset continuation, so there is no second cursor table.
 * Replays may coalesce to a newer generation, but never reset Rating's existing rebuild cursor.
 *
 * The source emits at most eight native homes per turn before handing off the next page.
 * This bounds how many relay homes a single recovery wake can place ahead of ordinary traffic.
 * Literal page cost: one <=8-row inventory seek, <=8 single-home commands (one keyed
 * conditional counter update each), and at most one continuation command. No Subject or Rating rows are read.
 */
export async function resumeCanonicalGenerationDelivery(
  pool: Pool,
  input: CanonicalGenerationPageRequest = { after: null, limit: CANONICAL_GENERATION_PAGE_SIZE },
): Promise<void> {
  const request = copyPage(input);
  const page = await readCanonicalGenerationDeliveryPage(
    pool,
    { ...request, limit: Math.min(request.limit, CANONICAL_GENERATION_SOURCE_BATCH_SIZE) },
    { deadline: Date.now() + DEFAULT_REQUEST_DEADLINE_MS },
  );
  for (const home of page.homes) {
    await runCommand(pool, { partition: home.partition }, async (tx) => {
      // Commit the notification marker and its native event together. Startup recovery
      // redelivers every outstanding generation, including an exhausted receiver workflow.
      const announced = await tx.query<{ generation: string }>(
        `UPDATE semantic.partition_subjects SET canonical_announced_generation=canonical_generation
         WHERE partition_no=$1 AND canonical_delivered_generation<canonical_generation
           ${request.unannouncedOnly ? 'AND canonical_announced_generation<canonical_generation' : ''}
         RETURNING canonical_generation::text AS generation`,
        [home.partition],
      );
      const row = announced.rows[0];
      if (!row) return noEffect(null);
      return {
        value: null,
        events: [{
          type: CANONICAL_GENERATION_COMMITTED,
          data: { partition: home.partition, generation: row.generation },
        }],
      };
    });
  }
  if (page.after !== null) {
    // A crash before this commit replays the original wake; a crash after it replays this page.
    await runCommand(pool, { partition: page.after }, async () => ({
      value: null,
      events: [{ type: CANONICAL_GENERATION_CONTINUATION, data: { ...request, after: page.after } }],
    }));
  }
}

/** Run one receiving page under the native home command. A full page commits a continuation
 * with the original notification intact. A terminal page and its checked watermark commit
 * together, so a failed receiver or a bad witness leaves both unchanged.
 */
export async function deliverCanonicalGenerationEvent(
  pool: Pool,
  event: CloudEvent,
  receive: CanonicalGenerationReceiver,
): Promise<void> {
  const home = nativeHome(event);
  const original = event.type === CANONICAL_GENERATION_REBUILD_CONTINUED ? event.data : event;
  if (!Value.Check(SEMANTIC_EVENTS[CANONICAL_GENERATION_REBUILD_CONTINUED], original))
    throw new TypeError('Invalid committed canonical generation event');
  const { partition, generation } = original.data;
  if (home !== partition || nativeHome(original) !== partition || !validGeneration(generation))
    throw new TypeError('Canonical generation event does not belong to its native home');
  await runCommand(pool, { partition }, async (tx) => {
    const row = (
      await tx.query<{ generation: string; delivered: string }>(
        `SELECT canonical_generation::text AS generation,canonical_delivered_generation::text AS delivered
       FROM semantic.partition_subjects WHERE partition_no=$1 FOR UPDATE`,
        [partition],
      )
    ).rows[0];
    if (!row || BigInt(row.generation) < BigInt(generation))
      throw new Error('Canonical generation has not committed at its home');
    if (BigInt(row.delivered) >= BigInt(generation)) return noEffect(null);

    const witness = await receive(tx, { partition, generation }, original);
    if (
      !witness ||
      witness.partition !== partition ||
      witness.canonicalGeneration !== row.generation ||
      !validGeneration(witness.revision) ||
      typeof witness.complete !== 'boolean'
    )
      throw new Error('Invalid whole-home canonical generation witness');
    if (!witness.complete)
      return { value: null, events: [{ type: CANONICAL_GENERATION_REBUILD_CONTINUED, data: original }] };

    // A rebuild can cover a newer committed generation. This event acknowledges only its original generation.
    await tx.query('UPDATE semantic.partition_subjects SET canonical_delivered_generation=$2 WHERE partition_no=$1', [
      partition,
      generation,
    ]);
    return { value: null, events: [{ type: CANONICAL_GENERATION_DELIVERED, data: { partition, generation } }] };
  });
}

/** Existing mutation events are wake hints, never evidence of complete canonical coverage.
 * Context directory changes leave the canonical home counters alone.
 * Mechanical delivery/locator events are excluded to avoid a notification feedback loop.
 * Startup always revisits the retained counters, recovering missing or exhausted deliveries.
 */
export function createCanonicalGenerationWakeEffect(pool: Pool): Effect {
  const types = [
    CANONICAL_GENERATION_CONTINUATION,
    ...Object.keys(SEMANTIC_EVENTS).filter((type) =>
      type !== contextDirectoryChanged &&
      !type.startsWith('com.rezics.semantic.canonical-generation.') &&
      !type.startsWith('com.rezics.semantic.erasure.locator-'),
    ),
    'com.rezics.subject.created.v1',
    'com.rezics.subject.visibility_changed.v1',
    'com.rezics.subject.statement_visibility_changed.v1',
  ];
  return {
    name: 'semantic_canonical_generation',
    types,
    async run(event) {
      nativeHome(event);
      // Previously queued context wakes still need to complete their delivery.
      if (event.type === contextDirectoryChanged) return;
      if (event.type === CANONICAL_GENERATION_CONTINUATION) {
        if (!Value.Check(SEMANTIC_EVENTS[CANONICAL_GENERATION_CONTINUATION], event.data))
          throw new TypeError('Invalid canonical generation continuation');
        await resumeCanonicalGenerationDelivery(pool, event.data as CanonicalGenerationPageRequest);
      } else {
        if (!types.includes(event.type)) throw new TypeError('Unexpected canonical generation wake');
        await resumeCanonicalGenerationDelivery(pool, { after: null, limit: CANONICAL_GENERATION_PAGE_SIZE, unannouncedOnly: true });
      }
    },
  };
}
