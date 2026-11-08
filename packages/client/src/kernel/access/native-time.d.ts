import type { AccessContext } from '../request/access.ts';
import type { KernelClock } from '../clock.ts';
import { type AuthoritativeTime } from '../command/command.ts';
/** Native read time minted from this exact admitted SQL observation. Caller releases it. */
export declare function readNativeAccessTime(context: AccessContext, clock?: KernelClock, instant?: string): Promise<AuthoritativeTime>;
