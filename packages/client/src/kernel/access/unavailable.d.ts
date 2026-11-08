import { CommandUnavailableError } from './contract/errors.ts';
export { AccessUnavailableError, CommandUnavailableError } from './contract/errors.ts';
/** Constant-time classification shared by Access, commands, HTTP, and durable work. */
export declare function classifyUnavailability(error: unknown): CommandUnavailableError['reason'] | undefined;
export declare function requireAccessDeadline(deadline: number): void;
export declare function throwAccessUnavailable(error: unknown, deadline?: number): void;
