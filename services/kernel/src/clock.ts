/** Trusted domain time; authentication and execution budgets retain actual wall time. */
export type KernelClock = () => Date;

export const systemClock: KernelClock = () => new Date();
