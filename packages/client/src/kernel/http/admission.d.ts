export declare const ADMISSION_LIMITS: {
    readonly permits: 8;
    readonly reserved: 2;
    readonly queue: 32;
};
export type AdmissionLane = 'normal' | 'reserved';
export type JobContext = {
    deadline: number;
    signal?: AbortSignal;
};
type Limits = {
    permits: number;
    reserved: number;
    queue: number;
};
/** Temporarily releases a permit during an explicit wait, then fairly reacquires it. */
export type AdmissionYield = <T>(wait: () => Promise<T>) => Promise<T>;
export declare class Admission {
    private readonly limits;
    private readonly active;
    private readonly queue;
    constructor(limits?: Limits);
    get running(): Readonly<{
        normal: number;
        reserved: number;
    }>;
    get waiting(): number;
    run<T>(lane: AdmissionLane, context: JobContext, job: (yieldPermit: AdmissionYield) => T | Promise<T>): Promise<T>;
    private acquire;
    private capacity;
    private release;
    private clear;
    private remove;
    private drain;
}
export {};
