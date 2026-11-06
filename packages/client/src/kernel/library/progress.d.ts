import { type ProgressOutcome, type ProgressSessionCreate, type ProgressUnitRules } from '@rezics/progress';
export * from '@rezics/progress';
/** Routed reference admission belongs to Library; the shared core receives identities as values. */
export declare function parseSessionCreate(input: unknown, descriptor?: ProgressUnitRules | 'syntax'): ProgressOutcome<ProgressSessionCreate>;
