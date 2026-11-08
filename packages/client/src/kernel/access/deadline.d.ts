import type { AccessClient } from '../request/access.ts';
export declare function remaining(deadline: number): number;
/** Also bounds pool queueing and transports that do not honor AbortSignal. */
export declare function within<T>(deadline: number, work: () => Promise<T>): Promise<T>;
/** Preserve pg's decoding capabilities when wrapping reylo's query transport. */
export declare function deadlineClient(client: AccessClient, deadline: number): AccessClient;
