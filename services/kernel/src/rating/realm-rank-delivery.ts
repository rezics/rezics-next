import type { CommandTransaction } from '../command/command.ts';
import type { CloudEvent } from '../events/log.ts';
import { partitionOf, routeOf } from '../route/route.ts';

export type RatingSourcePosition = Readonly<{ epoch: number; position: string; revision: number }>;

/** Native log positions order membership epochs and pages, independently of vote revision or wall time. */
export function ratingSourcePosition(
  event: CloudEvent,
  ownerId: string,
  revision = 0,
): RatingSourcePosition | undefined {
  const source = /^urn:rezics:log:([0-9]+)\.([1-9][0-9]*)$/.exec(event.source);
  // Direct, pre-log callers retain their existing contract; production relay always supplies the native envelope.
  if (!source || Number(source[1]) !== partitionOf(routeOf(ownerId)!)) return undefined;
  if (!/^[0-9]{1,19}$/.test(event.sequence) || BigInt(event.sequence) < 1n)
    throw new TypeError('Invalid rating source position');
  const epoch = Number(source[2]);
  if (!Number.isSafeInteger(epoch)) throw new TypeError('Invalid rating source epoch');
  return { epoch, position: BigInt(event.sequence).toString(), revision };
}

/** Retained even after a membership or population vote is removed. The caller's command owns the receipt. */
export async function advanceRatingSource(
  tx: CommandTransaction,
  route: number,
  consumer: 'membership' | 'eligibility' | 'aggregate',
  key: readonly string[],
  source: RatingSourcePosition | undefined,
): Promise<boolean> {
  if (!source) return true;
  const result = await tx.query(
    `INSERT INTO rating.realm_rank_delivery(route,consumer,key,epoch,position,revision)
     VALUES($1,$2,$3,$4,$5,$6)
     ON CONFLICT(route,consumer,key) DO UPDATE
       SET epoch=EXCLUDED.epoch,position=EXCLUDED.position,revision=EXCLUDED.revision
       WHERE (realm_rank_delivery.epoch,realm_rank_delivery.position,realm_rank_delivery.revision)
           < (EXCLUDED.epoch,EXCLUDED.position,EXCLUDED.revision)
     RETURNING 1`,
    [route, consumer, key, source.epoch, source.position, source.revision],
  );
  return result.rows.length > 0;
}
