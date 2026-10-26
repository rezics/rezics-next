/** Access could not finish; absence of evidence is not evidence of a denial. */
export declare class AccessUnavailableError extends Error {
    readonly reason: 'deadline' | 'overloaded' | 'contention';
    constructor(reason: 'deadline' | 'overloaded' | 'contention');
}
export declare class CommandUnavailableError extends Error {
    readonly reason: 'fenced' | 'moved' | 'contention' | 'deadline' | 'overloaded';
    readonly partition: number;
    readonly movedTo: string | null;
    constructor(reason: CommandUnavailableError['reason'], partition: number, movedTo?: string | null);
}
/** Constant-time classification shared by Access, commands, HTTP, and durable work. */
export declare function classifyUnavailability(error: unknown): CommandUnavailableError['reason'] | undefined;
export declare function requireAccessDeadline(deadline: number): void;
export declare function throwAccessUnavailable(error: unknown, deadline?: number): void;
