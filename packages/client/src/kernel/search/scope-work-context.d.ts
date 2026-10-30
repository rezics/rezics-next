import type { Pool } from 'pg';
import { type AuthoritativeTime } from '../command/command.ts';
import { type OperationalTransaction } from '../command/operational.ts';
import { type MembersPreparationWorkDefinition, type PreparationLocator } from '../library/members-preparation.ts';
import type { Access } from '../request/access.ts';
/** SERVER ONLY. A native lookup, never an Actor, permission, DTO or persisted cursor value. */
export type MembersPreparationWorkContext = Readonly<{
    kind: 'members-preparation';
    tx: OperationalTransaction;
    locator: PreparationLocator;
}>;
/** Read the actual immutable producer inputs on each use, with no retained admission verdict. */
export declare function readMembersPreparationWorkDefinition(work: MembersPreparationWorkContext, options: Readonly<{
    pool: Pool;
    access: Access;
    deadline: number;
}>): Promise<MembersPreparationWorkDefinition>;
/** Trusted time comes only from the live Core attempt, after native immutable episode admission. */
export declare function admitMembersPreparationWork(work: MembersPreparationWorkContext, options: Readonly<{
    pool: Pool;
    access: Access;
    deadline: number;
}>): Promise<AuthoritativeTime>;
