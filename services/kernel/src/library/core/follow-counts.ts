import { FollowCountUnavailableError } from '../contract/index.ts';

/** Missing native evidence is unknown, even for an otherwise empty target. */
export function followCountScalar(value: string | undefined): number {
  if (value === undefined || !/^(0|[1-9][0-9]*)$/.test(value)) throw new FollowCountUnavailableError();
  const integer = BigInt(value);
  if (integer > BigInt(Number.MAX_SAFE_INTEGER)) throw new FollowCountUnavailableError('Count exceeds DTO range');
  return Number(integer);
}

/** These times are observations from the same native database clock. The extra
 * five seconds cover a source command still uncommitted at sample time. */
export function followCountHealthCurrent(
  input: Readonly<{
    now: number;
    sampledAt: number;
    oldestPendingAt: number | null;
    consumer: Readonly<{ observedAt: number; oldestPendingAt: number | null }> | null;
  }>,
): boolean {
  const sampleAge = input.now - input.sampledAt;
  const pendingAge = input.oldestPendingAt === null ? 0 : input.now - input.oldestPendingAt;
  const cutoff = input.now - 300_000;
  return (
    Number.isFinite(sampleAge) &&
    Number.isFinite(pendingAge) &&
    sampleAge >= 0 &&
    pendingAge >= 0 &&
    Math.max(sampleAge, pendingAge) + 5_000 <= 300_000 &&
    input.consumer !== null &&
    Number.isFinite(input.consumer.observedAt) &&
    input.consumer.observedAt >= cutoff &&
    (input.consumer.oldestPendingAt === null ||
      (Number.isFinite(input.consumer.oldestPendingAt) && input.consumer.oldestPendingAt >= cutoff))
  );
}
