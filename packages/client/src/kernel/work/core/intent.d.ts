import type { WorkIntent, WorkScopedRequest } from '../contract/index.ts';
export declare function assertWorkIntent(intent: WorkIntent): void;
export declare function assertScopedWorkIdentity(request: WorkScopedRequest, custodyId?: string): void;
export declare function assertSelectedNativeDeclarations(native: readonly Readonly<{
    sql: string;
    limit: number;
}>[]): void;
