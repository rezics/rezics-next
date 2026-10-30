import type { AuthoritativeTime } from '../command/command.ts';
import { ProblemError } from '../http/problem.ts';
import type { AccessClient } from '../request/access.ts';

export type RealmMemberCount = Readonly<{ count: number; version: string }>;

/** Accounts installs the native source here; this declaration proves no count. */
export async function readRealmMemberCount(
  _client: AccessClient,
  _input: Readonly<{ realmId: string; at: AuthoritativeTime }>,
): Promise<RealmMemberCount | null> {
  throw new ProblemError('dependency_unavailable', { detail: 'Realm member count unavailable' });
}
