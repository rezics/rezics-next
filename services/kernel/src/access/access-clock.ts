import { systemClock, type KernelClock } from '../clock.ts';
import type { Access } from '../request/access.ts';
import { accessRoot } from './derived-access.ts';

const clocks = new WeakMap<Access, KernelClock>();

/** Internal Access composition only; derived adapters share their root's clock. */
export function accessClock(access: Access): KernelClock {
  return clocks.get(accessRoot(access)) ?? systemClock;
}

export function installAccessClock(access: Access, clock: KernelClock): void {
  clocks.set(accessRoot(access), clock);
}
