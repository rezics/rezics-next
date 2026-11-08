import type { CommandTransaction } from '../command/command.ts';
export declare function redirectOf(client: CommandTransaction, id: string): Promise<string | null>;
