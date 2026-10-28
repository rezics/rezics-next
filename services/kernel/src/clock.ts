/** Kernel domain time, used for domain rules and lifetimes the kernel issues itself.
 * Bearer credentials issued outside the kernel, and request and evidence budgets,
 * use actual wall time.
 */
export type KernelClock = () => Date;

export const systemClock: KernelClock = () => new Date();
