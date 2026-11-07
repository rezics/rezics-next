import type { AccessAccountActor } from './vocabulary.ts';
import type { AccessWorkDimensions } from './bounds.ts';

/** Native account admission is before private Copy state and exact receipt disclosure. */
export interface CopyAccountAdmission<Client, Time> {
  admit(client: Client, owner: AccessAccountActor): Promise<void>;
  check(
    owner: AccessAccountActor,
    route: number,
    at: Time,
    deadline: number,
  ): Promise<(client: Client, at: Time) => Promise<boolean>>;
  denied(): Error;
}
export type CopyAccountStatementWork = AccessWorkDimensions & Readonly<{ engineRequests: 0 }>;
export interface CopyAccountWork {
  floor(route: number, accountId: string): CopyAccountStatementWork;
  command(route: number, accountId: string): CopyAccountStatementWork;
  share(route: number, accountId: string): CopyAccountStatementWork;
}
