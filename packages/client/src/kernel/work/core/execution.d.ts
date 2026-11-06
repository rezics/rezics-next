export type WorkExecutionSnapshot = Readonly<{
    deadline: number;
    claimed: boolean;
    attempts: number;
}>;
export declare function executionDeadlineLive(deadline: number, now: number): boolean;
export declare function assertOpenExecution(deadline: number, now: number): void;
export declare function nextExecutionAttempt(attempts: number): number;
export declare function selectedContinuationInput(locator: Readonly<{
    ownerAccountId: string;
    route: number;
    collectionId: string;
    episodeId: string;
}>): string;
