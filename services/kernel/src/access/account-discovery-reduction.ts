import type { Pool } from 'pg';
import { createHash } from 'node:crypto';
import { DEFAULT_REQUEST_DEADLINE_MS } from '../command/command.ts';
import { readPartitions } from '../partition/partition.ts';
import { deadlineFor, withRequestDeadline } from '../request/deadline.ts';
import { withReadTransaction } from '../semantic/read.ts';
import { publicFilterCreationConsumer } from '../semantic/public-filter-creation-consumer.ts';
import { CommandUnavailableError, requireAccessDeadline, throwAccessUnavailable } from './unavailable.ts';
export { publicFilterCreationConsumer } from '../semantic/public-filter-creation-consumer.ts';

export type AccountDiscoveryReductionHead = Readonly<{
  partition: number;
  epoch: number;
  revision: bigint;
  claimRevision: bigint;
}>;
export type AccountDiscoveryReductionBinding = Readonly<{
  owner: 'accounts';
  heads: readonly AccountDiscoveryReductionHead[];
}>;

/** Native heads only. The registered shared Source owns the fixed full domain,
 * original immutable capture, comparison and independent physical incarnation.
 */
export async function readAccountDiscoveryReductionBinding(
  pool: Pool,
  partitions: readonly number[],
  context: Readonly<{ deadline: number }>,
): Promise<AccountDiscoveryReductionBinding> {
  const requested = [...new Set(partitions)].sort((a, b) => a - b);
  if (requested.length === 0 || requested.length > 100)
    throw new RangeError('Account discovery reductions require 1 to 100 distinct partitions');
  for (const partition of requested) {
    if (!Number.isInteger(partition) || partition < 0 || partition > 4095)
      throw new RangeError('Account discovery partition must be an integer from 0 to 4095');
  }
  if (!Number.isFinite(context.deadline)) throw new TypeError('Account discovery requires a finite deadline');
  const deadline = Math.min(context.deadline, deadlineFor(DEFAULT_REQUEST_DEADLINE_MS));
  requireAccessDeadline(deadline);
  try {
    return await withRequestDeadline(deadline, () =>
      withReadTransaction(pool, async (client) => {
        const homes = new Map((await readPartitions(client, requested)).map((home) => [home.partitionNo, home]));
        const counters = await client.query<{ partition: number; revision: string; claimRevision: string }>(
          `SELECT partition_no AS partition, revision::text, claim_revision::text AS "claimRevision"
           FROM access.account_discovery_population WHERE partition_no = ANY($1::integer[])`,
          [requested],
        );
        const byPartition = new Map(counters.rows.map((row) => [row.partition, row]));
        const heads = requested.map((partition): AccountDiscoveryReductionHead => {
          const home = homes.get(partition);
          if (!home) throw new CommandUnavailableError('contention', partition);
          if (home.writeState !== 'active')
            throw new CommandUnavailableError(
              home.writeState === 'moved' ? 'moved' : 'fenced',
              partition,
              home.movedTo,
            );
          const counter = byPartition.get(partition);
          if (!counter || BigInt(counter.revision) <= 0n || BigInt(counter.claimRevision) <= 0n)
            throw new CommandUnavailableError('contention', partition);
          return Object.freeze({
            partition,
            epoch: home.epoch,
            revision: BigInt(counter.revision),
            claimRevision: BigInt(counter.claimRevision),
          });
        });
        requireAccessDeadline(deadline);
        return Object.freeze({ owner: 'accounts', heads: Object.freeze(heads) });
      }),
    );
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
    if (code === '42P01' || code === '42703') throw new CommandUnavailableError('contention', requested[0]!);
    // Preserve moved/fenced routing information, and classify bounded read failures.
    throwAccessUnavailable(error, deadline);
    throw error;
  }
}

/** One retained original home receipt. The tuple domains deliberately stay separate. */
export type AccountDiscoveryEnrollment = AccountDiscoveryReductionHead &
  Readonly<{
    sourcePosition: bigint;
    creationPosition: bigint;
    enqueueRevision: bigint;
    keyDigest: string;
    receipt: string | null;
    complete: boolean;
  }>;

/** Enrol one bounded page of the immutable compiler closure in its writer home.
 * Account writers and enrollment take population -> Source head -> enrollment.
 * No registration-home transaction is held across this operation. The original
 * baseline is sealed only after the complete key closure is enrolled. A partial
 * key frontier is never an admitted baseline; sealed receipts are immutable.
 */
export async function enrollAccountDiscoveryHome(
  pool: Pool,
  input: Readonly<{
    partition: number;
    bootstrap: string;
    registration: Readonly<{ partition: number; id: string }>;
    readDefinition: string;
    keys: readonly string[];
    accounts: boolean;
  }>,
  context: Readonly<{ deadline: number }>,
): Promise<AccountDiscoveryEnrollment> {
  if (!Number.isInteger(input.partition) || input.partition < 0 || input.partition > 4095)
    throw new RangeError('Enrollment requires an exact native home');
  const keys = [...new Set(input.keys)].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const keyDigest = createHash('sha256').update(JSON.stringify(keys)).digest('hex');
  const creationConsumer = publicFilterCreationConsumer(input.bootstrap);
  const { withConnection, discardConnection } = await import('../database/pool.ts');
  return withRequestDeadline(context.deadline, () =>
    withConnection(pool, async (client) => {
      requireAccessDeadline(context.deadline);
      await client.query('BEGIN');
      try {
        await client.query(
          `SET LOCAL statement_timeout = '${Math.max(1, Math.floor(context.deadline - Date.now()))}ms'`,
        );
        const owner = (
          await client.query<{ epoch: number; position: string; write_state: string }>(
            'SELECT epoch,position::text,write_state FROM core.partition WHERE partition_no=$1 FOR SHARE',
            [input.partition],
          )
        ).rows[0];
        if (!owner || owner.write_state !== 'active')
          throw new CommandUnavailableError(owner?.write_state === 'moved' ? 'moved' : 'fenced', input.partition);
        const account = (
          await client.query<{ revision: string; claim_revision: string }>(
            `SELECT revision::text,claim_revision::text FROM access.account_discovery_population
         WHERE partition_no=$1 FOR UPDATE`,
            [input.partition],
          )
        ).rows[0];
        const source = (
          await client.query<{ position: string }>(
            `SELECT position::text FROM semantic.public_filter_privacy_head WHERE partition_no=$1 FOR UPDATE`,
            [input.partition],
          )
        ).rows[0];
        if (!account || !source) throw new CommandUnavailableError('contention', input.partition);
        const pending = (
          await client.query<{ enqueue_revision: string }>(
            `SELECT enqueue_revision::text FROM semantic.public_filter_privacy_pending
         WHERE partition_no=$1 AND input_key='["domain","accounts"]'`,
            [input.partition],
          )
        ).rows[0];
        const enqueueRevision = pending?.enqueue_revision ?? '0';
        await client.query(
          `INSERT INTO semantic.public_filter_home_enrollment
           (partition_no,bootstrap,registration_partition,registration,read_definition,owner_epoch,
            source_position,native_revision,native_claim_revision,key_digest,creation_consumer)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (partition_no,bootstrap) DO NOTHING`,
          [
            input.partition,
            input.bootstrap,
            input.registration.partition,
            input.registration.id,
            input.readDefinition,
            owner.epoch,
            source.position,
            input.accounts ? account.revision : null,
            input.accounts ? account.claim_revision : null,
            keyDigest,
            creationConsumer,
          ],
        );
        const original = (
          await client.query<{
            owner_epoch: number;
            source_position: string;
            native_revision: string | null;
            native_claim_revision: string | null;
            key_after: string | null;
            complete: boolean;
            registration_partition: number;
            registration: string;
            read_definition: string;
            creation_position: string | null;
            native_enqueue_revision: string | null;
            key_digest: string | null;
            receipt: string | null;
            creation_consumer: string | null;
          }>(
            `SELECT owner_epoch,source_position::text,native_revision::text,native_claim_revision::text,
           key_after,complete,registration_partition,registration,read_definition::text,
           creation_position::text,native_enqueue_revision::text,key_digest,receipt,creation_consumer
         FROM semantic.public_filter_home_enrollment WHERE (partition_no,bootstrap)=($1,$2) FOR UPDATE`,
            [input.partition, input.bootstrap],
          )
        ).rows[0];
        if (
          !original ||
          original.owner_epoch !== owner.epoch ||
          original.registration_partition !== input.registration.partition ||
          original.registration !== input.registration.id ||
          original.read_definition !== input.readDefinition ||
          original.key_digest !== keyDigest ||
          original.creation_consumer !== creationConsumer ||
          (original.complete &&
            (original.receipt === null ||
              original.creation_position === null ||
              original.native_enqueue_revision === null)) ||
          (original.native_revision !== null) !== input.accounts
        )
          throw new CommandUnavailableError('contention', input.partition);
        // Install the pin before admitting the original baseline, under the same
        // native writer locks. A legacy sealed row without this pin cannot be
        // repaired by installing one later: its earlier log may already be gone.
        if (!original.complete) {
          await client.query(
            `INSERT INTO core.consumer_checkpoint(partition_no,consumer)
           VALUES ($1,$2) ON CONFLICT DO NOTHING`,
            [input.partition, creationConsumer],
          );
        }
        const pin = (
          await client.query<{ epoch: number | null; position: string }>(
            `SELECT epoch,position::text FROM core.consumer_checkpoint
         WHERE (partition_no,consumer)=($1,$2) FOR SHARE`,
            [input.partition, creationConsumer],
          )
        ).rows[0];
        if (
          !pin ||
          (pin.epoch !== null && pin.epoch !== owner.epoch) ||
          BigInt(pin.position) > BigInt(original.creation_position ?? owner.position)
        )
          throw new CommandUnavailableError('contention', input.partition);
        // Byte admission remains with the original definition compiler. Key writes,
        // lookahead and control rows all share this maintenance step's 1000 inputs.
        let low = 0,
          high = keys.length;
        while (low < high) {
          const middle = (low + high) >>> 1;
          if (
            original.key_after !== null &&
            Buffer.compare(Buffer.from(keys[middle]!), Buffer.from(original.key_after)) <= 0
          )
            low = middle + 1;
          else high = middle;
        }
        const admitted = keys.slice(low, low + 900);
        const complete = low + admitted.length === keys.length;
        const receipt =
          original.receipt ??
          (complete
            ? createHash('sha256')
                .update(
                  JSON.stringify([
                    input.partition,
                    input.bootstrap,
                    input.registration.partition,
                    input.registration.id,
                    input.readDefinition,
                    owner.epoch,
                    source.position,
                    owner.position,
                    enqueueRevision,
                    input.accounts ? account.revision : null,
                    input.accounts ? account.claim_revision : null,
                    keyDigest,
                  ]),
                )
                .digest('hex')
            : null);
        if (!original.complete) {
          // Allocate under the Source home lock, shared with fanout window capture.
          // A later enrollment must stay outside that window even when its key
          // sorts before the retained registration frontier.
          const generation = (
            await client.query<{ enrollment_generation: string }>(
              `UPDATE semantic.public_filter_privacy_head SET enrollment_generation=enrollment_generation+1
               WHERE partition_no=$1 RETURNING enrollment_generation::text`,
              [input.partition],
            )
          ).rows[0];
          if (!generation) throw new CommandUnavailableError('fenced', input.partition);
          await client.query(
            `INSERT INTO semantic.public_filter_key_enrollment
             (partition_no,input_key,registration_partition,registration,bootstrap,enrollment_generation)
           SELECT $1,k,$2,$3,$4,$6::bigint FROM unnest($5::text[]) k
           ON CONFLICT DO NOTHING`,
            [
              input.partition,
              input.registration.partition,
              input.registration.id,
              input.bootstrap,
              admitted,
              generation.enrollment_generation,
            ],
          );
          await client.query(
            `UPDATE semantic.public_filter_home_enrollment SET key_after=$3,complete=$4,
             source_position=CASE WHEN $4 THEN $5::bigint ELSE source_position END,
             native_revision=CASE WHEN $4 THEN $6::bigint ELSE native_revision END,
             native_claim_revision=CASE WHEN $4 THEN $7::bigint ELSE native_claim_revision END,
             creation_position=CASE WHEN $4 THEN $8::bigint ELSE creation_position END,
             native_enqueue_revision=CASE WHEN $4 THEN $9::bigint ELSE native_enqueue_revision END,
             receipt=$10
           WHERE (partition_no,bootstrap)=($1,$2) AND NOT complete`,
            [
              input.partition,
              input.bootstrap,
              admitted.at(-1) ?? original.key_after,
              complete,
              source.position,
              input.accounts ? account.revision : null,
              input.accounts ? account.claim_revision : null,
              owner.position,
              enqueueRevision,
              receipt,
            ],
          );
        }
        requireAccessDeadline(context.deadline);
        await client.query('COMMIT');
        return Object.freeze({
          partition: input.partition,
          epoch: original.owner_epoch,
          revision: BigInt(original.complete ? (original.native_revision ?? account.revision) : account.revision),
          claimRevision: BigInt(
            original.complete ? (original.native_claim_revision ?? account.claim_revision) : account.claim_revision,
          ),
          sourcePosition: BigInt(original.complete ? original.source_position : source.position),
          creationPosition: BigInt(original.complete ? original.creation_position! : owner.position),
          enqueueRevision: BigInt(original.complete ? original.native_enqueue_revision! : enqueueRevision),
          keyDigest,
          receipt,
          complete: original.complete || complete,
        });
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackError) {
          discardConnection(client, rollbackError as Error);
        }
        throw error;
      }
    }),
  );
}
