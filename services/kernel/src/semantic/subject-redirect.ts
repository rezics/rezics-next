import type { CommandTransaction } from '../command/command.ts';
import { routeOf } from '../route/route.ts';
import readRedirect from './read-redirect.sql';

export class SubjectRedirectError extends Error {
  constructor(
    public readonly from: string,
    public readonly to: string,
  ) {
    super('Subject has been redirected');
  }
}

export async function redirectOf(client: CommandTransaction, id: string): Promise<string | null> {
  const row = await readRedirect.run(client, { route: routeOf(id)!, subject_id: id });
  return row?.target ?? null;
}
