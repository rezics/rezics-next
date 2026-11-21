export declare const ADMISSION_LIMITS: {
    readonly permits: 8;
    readonly reserved: 2;
    readonly bearer: 4;
    readonly queue: 32;
};
export type AdmissionLane = 'normal' | 'reserved';
export type JobContext = {
    deadline: number;
    signal?: AbortSignal;
};
type AdmissionWork = AdmissionLane | 'bearer';
type Limits = {
    permits: number;
    reserved: number;
    bearer?: number;
    queue: number;
};
/** Temporarily releases a permit during an explicit wait, then fairly reacquires it. */
export type AdmissionYield = <T>(wait: () => Promise<T>) => Promise<T>;
export declare function requireLiveJob(context: JobContext): void;
export declare class Admission {
    private readonly limits;
    private readonly active;
    private readonly queue;
    private readonly normalJobs;
    constructor(limits?: Limits);
    get running(): Readonly<Record<AdmissionWork, number>>;
    get waiting(): number;
    /** A sequential Access preparation may use the enclosing native job's live permit. */
    prepare<T>(context: JobContext, job: () => Promise<T>, permit?: AdmissionYield): Promise<T>;
    run<T>(lane: AdmissionWork, context: JobContext, job: (yieldPermit: AdmissionYield) => T | Promise<T>): Promise<T>;
    private acquire;
    private available;
    private release;
    private clear;
    private remove;
    private drain;
}
export {};
