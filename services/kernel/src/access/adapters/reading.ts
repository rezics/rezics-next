import type { Pool } from 'pg';
import { readPublicIdentities } from '../account-data.ts';
import { deadlineClient, within } from '../authenticate.ts';
import { classifyUnavailability } from '../unavailable.ts';
import { ProblemError } from '../../http/problem-error.ts';
import { routeOf } from '../../route/route.ts';
import type { AccessReadingObservation, AccessReadingPorts, AccessReadingIdentity } from '../contract/index.ts';

/** Native errors are interpreted here, before a reading application sees an outcome. */
async function observe<T>(read: () => Promise<T>, deadline?: number): Promise<AccessReadingObservation<T>> {
  try {
    return { state: 'current', value: await (deadline === undefined ? read() : within(deadline, read)) };
  } catch (error) {
    if (
      classifyUnavailability(error) !== undefined ||
      (error instanceof ProblemError && error.code === 'dependency_unavailable')
    )
      return { state: 'unavailable' };
    throw error;
  }
}

/** One existing route-first public projection, on the caller's pool and original deadline. */
export function createNativeAccessReadingPorts(): AccessReadingPorts {
  return {
    observe,
    identities(pool, ids, deadline) {
      return observe(async () => {
        const native = pool as Pool;
        const client = deadline === undefined ? native : deadlineClient(native, deadline);
        const accounts = await readPublicIdentities(
          client,
          ids.map((id) => routeOf(id)!),
          ids,
        );
        const byId = new Map(accounts.map((account) => [account.id, account]));
        return ids.map((id): AccessReadingIdentity => {
          const account = byId.get(id);
          if (!account) return { id, state: 'unknown' };
          return account.state === 'deleted'
            ? { id, state: 'deleted' }
            : { id, state: 'active', handle: account.handle };
        });
      });
    },
  };
}
