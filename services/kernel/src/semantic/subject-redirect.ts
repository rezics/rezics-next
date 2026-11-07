import type { CommandTransaction } from '../command/command.ts';
import { routeOf } from '../route/route.ts';
import readRedirect from './read-redirect.sql';

export async function redirectOf(client: CommandTransaction, id: string): Promise<string | null> {
  const row = await readRedirect.run(client, { route: routeOf(id)!, subject_id: id });
  return row?.target ?? null;
}
