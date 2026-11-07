import type { Pool } from 'pg';
import type { KernelClock } from '../../clock.ts';
import type { AccessWorkAccounting } from '../../access/work.ts';
import { deadlineClient, accessCheck } from '../domain-ports.ts';
import { withConnection } from '../../database/pool.ts';
import type { Access, Actor } from '../../request/access.ts';
import { mintReadTime, authoritativeTimeValue } from '../../command/command.ts';
import { routeOf } from '../../route/route.ts';
import { readSpace, spaceReadEligibility } from '../space-read.ts';

/** Space/Realm disclosure is prepared anew before each native read, including final disclosure. */
export async function observeLibrarySpaceSummary(
  deps: { pool: Pool; access: Access; clock?: KernelClock },
  actor: Actor,
  id: string,
  type: string,
  deadline: number,
  work?: AccessWorkAccounting,
) {
  async function read() {
    const route = routeOf(id);
    if (route === null) return null;
    const identity = { route, id };
    const check = await accessCheck(
      deps.access,
      actor,
      'space:read',
      {
        ...identity,
        eligibility: spaceReadEligibility(identity),
      },
      { pool: deps.pool, deadline, ...(work ? { work } : {}) },
    );
    return withConnection(deps.pool, async (connection) => {
      const client = deadlineClient(connection, deadline);
      const time = await mintReadTime(client, deps.clock);
      if (!(await check(client, time))) return null;
      const value = await readSpace(client, id, authoritativeTimeValue(time));
      return value ? { id, type, label: value.title ?? '' } : null;
    });
  }
  const value = await read();
  return { value, current: async () => JSON.stringify(await read()) === JSON.stringify(value) };
}
