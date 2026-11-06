import type { CommandTransaction } from '../command/command.ts';

/** Account role mask bound on one live command. Structurally the History account reference. */
export type CommandHistoryAccount = Readonly<{
  accountRoute: number;
  accountId: string;
  roles: number;
}>;

const identities = new WeakMap<CommandTransaction, readonly CommandHistoryAccount[]>();

/** Access calls this only with opaque verified permission evidence, once per executor attempt.
 * This server module is never an HTTP JSON input or an alternate permission evaluator. */
export function bindCommandHistoryEvidence(tx: CommandTransaction, accounts: readonly CommandHistoryAccount[]): void {
  identities.set(tx, structuredClone(accounts));
}

/** Bound evidence for this attempt, or missing when Access has not bound any. */
export function boundCommandHistoryEvidence(tx: CommandTransaction): readonly CommandHistoryAccount[] | undefined {
  const accounts = identities.get(tx);
  return accounts ? structuredClone(accounts) : undefined;
}

/** The already verified evidence for this attempt, used only to enroll native data roles. */
export function commandHistoryIdentityAccounts(tx: CommandTransaction): readonly CommandHistoryAccount[] {
  return structuredClone(identities.get(tx) ?? []);
}

export function releaseCommandHistoryEvidence(tx: CommandTransaction): void {
  identities.delete(tx);
}
