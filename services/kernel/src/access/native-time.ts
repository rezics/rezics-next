import type { AccessClient, AccessContext } from '../request/access.ts';
import type { KernelClock } from '../clock.ts';
import { mintReadTime, type AuthoritativeTime } from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import { accessCheckout, accessNativeWork } from './work.ts';
import { deadlineClient, within } from './deadline.ts';
import { AccessUnavailableError } from './unavailable.ts';
import timeRead from './permission-time.sql';

/** Native read time minted from this exact admitted SQL observation. Caller releases it. */
export async function readNativeAccessTime(
  context: AccessContext,
  clock?: KernelClock,
  instant?: string,
): Promise<AuthoritativeTime> {
  const input = { at: instant ?? clock?.().toISOString() ?? '' };
  const row = await within(context.deadline, () =>
    accessCheckout(context.work, () =>
      withConnection(context.pool, (client) =>
        accessNativeWork(context.work, 'time', input, {}, () =>
          timeRead.run(deadlineClient(client, context.deadline), input),
        ),
      ),
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
