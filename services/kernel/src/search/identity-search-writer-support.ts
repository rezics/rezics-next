import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { CommandTransaction } from '../command/command.ts';
import { IdentityEpochStoreError } from '../semantic/contract/identity-errors.ts';
import { readRelease } from '../semantic/definitions.ts';
import type { IdentityChange, IdentityFrontier, IdentityJobRef } from '../semantic/identity-epoch-contract.ts';
import { createPublicFilterSourceBinding } from '../semantic/public-filter-source-binding.ts';
import { readPublicFilterSourceDefinition } from '../semantic/source-binding-application.ts';
import type { PublicFilterProjectionFrontier } from '../semantic/public-filter-source-contract.ts';
import { publicFilterSource } from '../semantic/public-filter-source.ts';
import { withReadTransaction } from '../semantic/read.ts';
import { readIdentitySourceProjection } from '../semantic/search-source.ts';
import { snapshotSearchIdentityReceivingFrontier } from './identity-receiving-native-contract.ts';
import type { SearchReceivingConfiguration } from './identity-receiving-native.ts';
import { readSearchIdentityWriterSupportSql } from './identity-search-receiving-directory-sql.ts';
import { subjectPartition } from './source.ts';

const unavailable = (message: string) => new IdentityEpochStoreError('identity_epoch_unavailable', message);
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const releaseDigest = /^sha256:[a-f0-9]{64}$/;
const marker = 'search-writer-support';

type Phase = 'definition' | 'original' | 'terminal';
type Definition = Readonly<{ transactionId: string; id: string; release: string }>;
type Projection = Readonly<{
  transactionId: string;
  state: 'progress' | 'complete' | 'withheld' | 'restart' | 'retiring';
  frontier: PublicFilterProjectionFrontier | null;
}>;
type Basis = Readonly<{
  job: IdentityJobRef;
  change: Pick<IdentityChange, 'original' | 'terminal'>;
  request: string;
  scope: string;
  release: string;
}>;

async function retained(tx: CommandTransaction, basis: Basis, phase: Phase) {
  const row = (
    await tx.query<{ transaction_id: string; frontier: unknown; proven: boolean }>(readSearchIdentityWriterSupportSql, [
      subjectPartition(basis.change.original),
      basis.job.jobId,
      String(basis.job.epoch),
      basis.request,
      phase,
      basis.scope,
    ])
  ).rows[0];
  if (!row) return null;
  const frontier = snapshotSearchIdentityReceivingFrontier(row.frontier);
  if (
    !row.proven ||
    !frontier ||
    frontier.segment !== 0 ||
    !isDeepStrictEqual(frontier.after.slice(0, 3), [marker, basis.request, phase])
  )
    throw unavailable('Search writer support changed at its retained owner');
  return { transactionId: row.transaction_id, after: frontier.after };
}

function decodeDefinition(row: Awaited<ReturnType<typeof retained>>, expectedRelease: string): Definition | null {
  if (!row) return null;
  const [, , , id, release] = row.after;
  if (row.after.length !== 5 || typeof id !== 'string' || !uuid.test(id) || release !== expectedRelease)
    throw unavailable('Retained Search Source definition differs from the admitted release');
  return { transactionId: row.transactionId, id, release: expectedRelease };
}

function decodeProjection(row: Awaited<ReturnType<typeof retained>>): Projection | null {
  if (!row) return null;
  const [, , , state, build, generation, continuation] = row.after;
  if (
    row.after.length === 7 &&
    state === 'retiring' &&
    typeof build === 'string' &&
    uuid.test(build) &&
    typeof generation === 'string' &&
    /^[1-9][0-9]*$/.test(generation) &&
    typeof continuation === 'number' &&
    Number.isInteger(continuation) &&
    continuation >= 0 &&
    continuation <= 4095
  )
    return { transactionId: row.transactionId, state, frontier: null };
  if (row.after.length === 4 && (state === 'withheld' || state === 'restart'))
    return { transactionId: row.transactionId, state, frontier: null };
  if (
    row.after.length !== 7 ||
    (state !== 'progress' && state !== 'complete') ||
    typeof build !== 'string' ||
    !uuid.test(build) ||
    typeof generation !== 'string' ||
    !/^[1-9][0-9]*$/.test(generation) ||
    typeof continuation !== 'string' ||
    !continuation
  )
    throw unavailable('Invalid Search writer support projection frontier');
  return { transactionId: row.transactionId, state, frontier: { build, generation: BigInt(generation), continuation } };
}

function closed(value: Projection | null) {
  return value?.state === 'complete' || value?.state === 'withheld';
}

export function createSearchIdentityWriterSupport(configuration: SearchReceivingConfiguration) {
  const { pool } = configuration;
  const source = publicFilterSource(configuration);
  const routeDigest = createHash('sha256').update(configuration.routeKey).digest('hex');
  return async (
    basis: Basis,
    deadline: number,
  ): Promise<Readonly<{
    frontier: IdentityFrontier;
    compare(tx: CommandTransaction): Promise<void>;
  }> | null> => {
    if (!releaseDigest.test(basis.release)) throw unavailable('Invalid admitted Search release');
    const saved = await withReadTransaction(
      pool,
      async (tx) => {
        const savedDefinition = decodeDefinition(await retained(tx, basis, 'definition'), basis.release);
        if (!savedDefinition) return { definition: null, phase: 'definition' as const, projection: null };
        const original = decodeProjection(await retained(tx, basis, 'original'));
        if (!closed(original)) return { definition: savedDefinition, phase: 'original' as const, projection: original };
        if (basis.change.original === basis.change.terminal) return null;
        const terminal = decodeProjection(await retained(tx, basis, 'terminal'));
        return closed(terminal)
          ? null
          : { definition: savedDefinition, phase: 'terminal' as const, projection: terminal };
      },
      deadline,
    );
    if (!saved) return null;

    const { phase } = saved;
    const after: (string | number | null)[] = [marker, basis.request, phase];
    if (saved.phase === 'definition') {
      const release = await readRelease(pool, basis.release);
      if (!release) throw unavailable('Search writer could not load the admitted Source release');
      const resolved = await createPublicFilterSourceBinding(
        pool,
        configuration.routeKey,
        configuration.access,
      ).resolve(
        {
          source,
          meaning: { digest: basis.release, release },
          capture: { sort: 'id', size: 20, filterDocument: undefined, text: undefined },
        },
        { deadline },
      );
      if (resolved.status !== 'resolved') throw unavailable('Search writer could not retain its Source definition');
      after.push(resolved.definition.readDefinition, basis.release);
    } else {
      const { definition: own, projection: prior } = saved;
      const { definition } = await readPublicFilterSourceDefinition(own.id, pool, routeDigest, 20480);
      if (definition.meaning.digest !== basis.release) throw unavailable('Search writer Source definition changed');
      const observed = await readIdentitySourceProjection(configuration, source, {
        job: basis.job,
        original: basis.change[saved.phase],
        terminal: basis.change.terminal,
        meaning: definition.meaning,
        frontier: prior?.frontier ?? null,
        inputLimit: 1,
        context: { deadline },
      });
      if (observed.status === 'unready' && observed.retirement) {
        const { build, generation, partition } = observed.retirement;
        after.push('retiring', build, generation, partition);
      } else if (observed.status === 'changed' && prior?.state === 'progress') after.push('restart');
      else if (observed.status !== 'projected') throw unavailable('Search writer Source projection is unavailable');
      else if (!observed.projection) after.push('withheld');
      else {
        const { status, frontier } = observed.projection;
        if (status === 'progress' && isDeepStrictEqual(frontier, prior?.frontier))
          throw unavailable('Search writer Source projection made no progress');
        after.push(status, frontier.build, String(frontier.generation), frontier.continuation);
      }
    }
    const frontier = snapshotSearchIdentityReceivingFrontier({ after, segment: 0 });
    if (!frontier) throw unavailable('Search writer Source support exceeds its retained frontier bound');
    const expected = saved.projection?.transactionId ?? null;
    return {
      frontier,
      async compare(tx) {
        if (((await retained(tx, basis, phase))?.transactionId ?? null) !== expected)
          throw unavailable('Search writer Source support was superseded');
      },
    };
  };
}
