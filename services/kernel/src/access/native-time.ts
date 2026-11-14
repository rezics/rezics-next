import type { AccessClient, AccessContext } from '../request/access.ts';
import type { KernelClock } from '../clock.ts';
import { mintReadTime, type AuthoritativeTime } from '../command/command.ts';
import { withBoundedReadConnection } from '../database/pool.ts';
import { accessCheckout, accessNativeWork } from './work.ts';
import { AccessUnavailableError, throwAccessUnavailable } from './unavailable.ts';
import timeRead from './permission-time.sql';

/** Native read time minted from this exact admitted SQL observation. Caller releases it. */
export async function readNativeAccessTime(
  context: AccessContext,
  clock?: KernelClock,
  instant?: string,
): Promise<AuthoritativeTime> {
  const input = { at: instant ?? clock?.().toISOString() ?? '' };
  const row = await accessCheckout(context.work, () =>
    withBoundedReadConnection(
      context.pool,
      context.deadline,
      (client) =>
        accessNativeWork(context.work, 'time', input, {}, () =>
          timeRead.run(client, input),
        ),
      {
        deadlineError: () => new AccessUnavailableError('deadline'),
        mapError(error) {
          try {
            throwAccessUnavailable(error, context.deadline);
          } catch (mapped) {
            return mapped;
          }
          return error;
        },
      },
    ),
  ).catch((error: unknown) => {
    context.work?.fail(error);
    throw error;
  });
  if (!row) throw new AccessUnavailableError('overloaded');
  return mintReadTime({
    query: (async () => ({
      rows: [{ at: row.at }],
      rowCount: 1,
      command: 'SELECT',
      oid: 0,
      fields: [],
    })) as AccessClient['query'],
  });
}
