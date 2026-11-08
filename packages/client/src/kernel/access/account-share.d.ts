import { type CommandTransaction } from '../command/command.ts';
import { type OperationalTransaction } from '../command/operational.ts';
/** Hold the account against deletion until the owning command commits or rolls back.
 * Call before creating per-account state; this does not replace command authorization.
 */
export declare function shareAccount(tx: CommandTransaction, accountId: string): Promise<'active'>;
/** The same terminal fence, without lending operational work command authority. */
export declare function fenceOperationalAccount(tx: OperationalTransaction, accountId: string): Promise<'active'>;
