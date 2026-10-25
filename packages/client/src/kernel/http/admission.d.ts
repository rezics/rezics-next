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
    run<T>(lane: AdmissionLane, context: JobContext, job: () => T | Promise<T>): Promise<T>;
    private capacity;
    private execute;
    private clear;
    private remove;
    private drain;
}
export {};
