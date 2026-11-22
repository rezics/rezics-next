import type { Pool } from 'pg';
import { runCommand, type CommandTransaction, type LegacyCommandOptions, type CommandOutcome, type CommandResult } from '../command/command.ts';
/** Called before the producer's first affected source IO. The source transaction
 * is rolled back and released before any foreign directory command is opened.
 * Receipt replay has already returned in Core before this callback is reached.
 */
export declare function admitIdentityTerminalCapture(tx: CommandTransaction, originals: readonly string[]): Promise<void>;
/** Two explicit phases: authenticated source discovery, released native drain,
 * then a newly authorized source attempt consuming that exact drain. Core owns
 * contention policy, including any enclosing single-attempt maintenance scope.
 */
type PrincipalOptions = Parameters<typeof runCommand>[1];
type Context = Parameters<Parameters<typeof runCommand>[2]>[1];
type Body<T> = (tx: CommandTransaction, context: Context) => Promise<CommandResult<T>>;
export declare function runIdentityTerminalCommand<T>(pool: Pool, options: LegacyCommandOptions, body: Body<T>): Promise<CommandOutcome<T>>;
export declare function runIdentityTerminalCommand<T>(pool: Pool, options: PrincipalOptions, body: Body<T>): Promise<CommandOutcome<T>>;
export {};
