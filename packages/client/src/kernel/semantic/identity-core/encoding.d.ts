import type { IdentityMapping } from './values.ts';
export declare function serializeIdentityValue(value: unknown): string;
/** Stable observation bytes used by native Rating equality and hashing. */
export declare function identityMappingObservationValue(mapping: IdentityMapping): readonly unknown[];
