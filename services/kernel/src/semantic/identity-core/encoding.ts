import type { IdentityMapping } from './values.ts';

export function serializeIdentityValue(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => (typeof entry === 'bigint' ? entry.toString() : entry));
}

/** Stable observation bytes used by native Rating equality and hashing. */
export function identityMappingObservationValue(mapping: IdentityMapping): readonly unknown[] {
  switch (mapping.state) {
    case 'mapped':
      return ['mapped', mapping.original, mapping.terminal, mapping.epoch.toString()];
    case 'pending':
      return ['pending', mapping.original, mapping.job.jobId, mapping.job.epoch.toString()];
    case 'unavailable':
      return ['unavailable', mapping.reason];
    case 'absent':
      return ['absent'];
  }
}
