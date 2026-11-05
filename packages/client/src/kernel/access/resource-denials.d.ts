import { type AuthoritativeTime, type CommandTransaction } from '../command/command.ts';
import type { Resource } from '../request/access.ts';
export { ResourceAccessWriteDeniedError } from './resource-access-errors.ts';
export type ResourceDenialWrite = {
    resource: Resource;
    subjectId: string;
    subjectRole: '';
    action: string;
    reason: 'resource' | 'suspension' | 'realm_ban';
    at: AuthoritativeTime;
};
/** The caller's command must already be authorized on this resource. `at` is that attempt's T. */
export declare function requireResourceCommand(tx: CommandTransaction, resource: Resource, at?: AuthoritativeTime): string;
/** Opens `[T, infinity)` for one denial key. An interval already open at T is left unchanged. */
export declare function recordResourceDenial(tx: CommandTransaction, input: ResourceDenialWrite): Promise<void>;
/** Closes the open denial at T. No open row is left unchanged. */
export declare function endResourceDenial(tx: CommandTransaction, input: ResourceDenialWrite): Promise<void>;
