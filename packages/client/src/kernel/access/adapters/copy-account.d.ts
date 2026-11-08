/** Access owns its private SQL, row projections and current authentication floor. */
import type { Pool } from 'pg';
import type { AuthoritativeTime, CommandTransaction } from '../../command/command.ts';
import { type Access } from '../check.ts';
import type { CopyAccountAdmission, CopyAccountWork } from '../contract/index.ts';
/** The full projection is the account-read producer's contract, including signed route and bigint maxima. */
export declare function nativeCopyAccountWork(): CopyAccountWork;
export declare function createNativeCopyAccountAdmission(config: {
    pool: Pool;
    access: Access;
}): CopyAccountAdmission<CommandTransaction, AuthoritativeTime>;
