import type { Pool, PoolClient } from 'pg';
import type {
  CurrentAccountEligibilityCapability,
  CurrentObservation,
  LibraryAccountSummary,
} from '../../library/contract/index.ts';
import type { ContributionAttribution } from '../contract/index.ts';
import { readAccount } from '../account-data.ts';
import { readPublicAccount, readContributionAttributions } from '../public-identity.ts';
import { deadlineClient } from '../authenticate.ts';
import { routeOf } from '../../route/route.ts';
import { withConnection } from '../../database/pool.ts';

export function createLibraryAccountEligibilityAdapter(): CurrentAccountEligibilityCapability<
  Pick<PoolClient, 'query'>
> {
  return { routeOf, readAccount };
}

export async function observeLibraryPublicAccount(
  pool: Pool,
  id: string,
  deadline: number,
): Promise<CurrentObservation<LibraryAccountSummary | null>> {
  async function read(): Promise<LibraryAccountSummary | null> {
    const route = routeOf(id);
    if (route === null) return null;
    const value = await withConnection(pool, (client) =>
      readPublicAccount(deadlineClient(client, deadline), route, id),
    );
    return value && value.state !== 'deleted' && 'handle' in value
      ? { id: value.accountId, handle: value.handle, displayName: value.displayName }
      : null;
  }
  const value = await read();
  return { value, current: async () => JSON.stringify(await read()) === JSON.stringify(value) };
}

export async function observeLibraryAttributions(
  pool: Pool,
  ids: readonly string[],
  deadline: number,
): Promise<CurrentObservation<ReadonlyMap<string, ContributionAttribution>>> {
  const read = () =>
    withConnection(pool, (client) => readContributionAttributions(deadlineClient(client, deadline), ids));
  const value = await read();
  return {
    value,
    async current() {
      const after = await read();
      return ids.every((id) => JSON.stringify(value.get(id)) === JSON.stringify(after.get(id)));
    },
  };
}
