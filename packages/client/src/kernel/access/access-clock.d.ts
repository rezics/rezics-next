import { type KernelClock } from '../clock.ts';
import type { Access } from '../request/access.ts';
/** Internal Access composition only; derived adapters share their root's clock. */
export declare function accessClock(access: Access): KernelClock;
export declare function installAccessClock(access: Access, clock: KernelClock): void;
