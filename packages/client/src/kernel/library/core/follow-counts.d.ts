/** Missing native evidence is unknown, even for an otherwise empty target. */
export declare function followCountScalar(value: string | undefined): number;
/** These times are observations from the same native database clock. The extra
 * five seconds cover a source command still uncommitted at sample time. */
export declare function followCountHealthCurrent(input: Readonly<{
    now: number;
    sampledAt: number;
    oldestPendingAt: number | null;
    consumer: Readonly<{
        observedAt: number;
        oldestPendingAt: number | null;
    }> | null;
}>): boolean;
