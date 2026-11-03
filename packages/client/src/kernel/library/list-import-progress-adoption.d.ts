import type { Actor } from '../request/access.ts';
import { nativeProgressUnit, type LibraryProfileDescriptor, type LibraryProfilePin } from './profile.ts';
import { type ProgressSessionCreate } from './progress.ts';
import type { createSessionCommands } from './sessions.ts';
export type ProgressSourceValue = {
    field: string;
    unit: string | null;
    state: 'zero' | 'value' | 'missing' | 'unknown' | 'invalid';
    amount?: string;
};
export type ProgressAdoptionInput = {
    occurrence: {
        kind: 'existing';
        sessionId: string;
    } | {
        kind: 'start';
        primaryUnit: string;
    };
    measures: {
        field: string;
        action: 'adopt' | 'clear';
        replace?: boolean;
    }[];
};
export type ProgressProfileBinding = {
    pin: Extract<LibraryProfilePin, {
        provenance: 'profile';
    }>;
    epoch: string;
    acceptingType: string;
};
export type ProgressAdoptionPlanMeasure = {
    field: string;
    unit: string | null;
    action: 'adopt' | 'clear';
    replace: boolean;
    state: ProgressSourceValue['state'];
    amount: string | null;
    currentAmount: string | null;
    eligibility: 'ready' | 'missing' | 'unknown' | 'invalid' | 'unsupported';
    reason: string | null;
};
export type ProgressAdoptionPlan = {
    subjectId: string;
    profile: ProgressProfileBinding;
    requestKeySeed: string;
    occurrence: {
        kind: 'existing';
        sessionId: string;
        startedAt: string;
        transactionId: string;
        revision: number;
        state: string;
        mode: string;
        units: string[];
    } | {
        kind: 'start';
        primaryUnit: string;
        requestKey: string;
        input: ProgressSessionCreate | null;
        reason: string | null;
    };
    measures: ProgressAdoptionPlanMeasure[];
};
export type ProgressAdoptionMeasureResult = {
    field: string;
    unit: string | null;
    action: 'adopt' | 'clear';
    status: 'applied' | 'cleared' | 'preserved' | 'missing' | 'unknown' | 'invalid' | 'unsupported' | 'stale' | 'failed' | 'unattempted';
    sourceAmount: string | null;
    currentAmount: string | null;
    reason: string | null;
};
export type ProgressAdoptionCheckpoint = {
    startAttempted?: boolean;
    occurrence: {
        sessionId: string;
        startedAt: string;
        transactionId: string;
        revision: number;
    } | null;
    lastRevision: number | null;
    steps: Record<string, {
        requestKey: string;
        revision: number;
        attempted: boolean;
        result?: ProgressAdoptionMeasureResult;
    }>;
    measures: ProgressAdoptionMeasureResult[];
    complete: boolean;
};
type SessionCommands = ReturnType<typeof createSessionCommands>;
type NativeCommand = Awaited<ReturnType<SessionCommands['startSession']>> | Awaited<ReturnType<SessionCommands['recordProgress']>>;
export declare function progressMeasureUnit(profile: LibraryProfileDescriptor | null, unit: string | null): ReturnType<typeof nativeProgressUnit>;
export declare function describeProgressSources(profile: LibraryProfileDescriptor | null, sources: readonly ProgressSourceValue[]): {
    readonly field: string;
    readonly unit: string | null;
    readonly state: "invalid" | "missing" | "unknown" | "value" | "zero";
    readonly unitSupported: boolean;
    readonly amount?: string;
    readonly eligibility: "invalid" | "missing" | "ready" | "unknown" | "unsupported" | "value" | "zero";
    readonly reason: "current-profile-does-not-admit-scalar-unit" | "source-field-has-no-unit-mapping" | "source-value-is-outside-current-profile-rules" | null;
}[];
export declare function reviewProgressAdoption(sessions: SessionCommands, actor: Actor, subjectId: string, profile: LibraryProfileDescriptor, binding: ProgressProfileBinding, sourceValues: readonly ProgressSourceValue[], input: ProgressAdoptionInput, startRequestKey: string): Promise<ProgressAdoptionPlan>;
export declare function emptyProgressCheckpoint(): ProgressAdoptionCheckpoint;
export declare function progressResults(plan: ProgressAdoptionPlan, checkpoint: ProgressAdoptionCheckpoint | null | undefined): ProgressAdoptionMeasureResult[];
export declare function executeProgressAdoption(actor: Actor, sessions: SessionCommands, plan: ProgressAdoptionPlan, prior: ProgressAdoptionCheckpoint | null | undefined, controls: {
    canceled(): Promise<boolean>;
    binding(): Promise<ProgressProfileBinding | null>;
    save(checkpoint: ProgressAdoptionCheckpoint, admission?: boolean): Promise<boolean | void>;
    recordNative?(command: NativeCommand): void;
}): Promise<ProgressAdoptionCheckpoint>;
export {};
