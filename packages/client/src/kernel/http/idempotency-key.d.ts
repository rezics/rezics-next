import { type CommandPrincipal } from '../command/key.ts';
export declare function idempotencyKeyOf(header: string | null | undefined, principal?: CommandPrincipal): string;
