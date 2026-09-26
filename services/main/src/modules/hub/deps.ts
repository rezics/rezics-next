import type { PackageLockRequest } from '../package/lock.ts';

export class HubDependencyInvalid extends Error {}

export interface HubDependencyRequest {
  profile: 'hub-dependency-lock-v1';
  revision: string;
  actingSubject: string;
  segments: Array<PackageLockRequest['segments'][number] & { requirements: number[] }>;
}

export interface HubRequirementBinding {
  ordinal: number; ecosystem: string; strength: 'required' | 'optional';
  declaration: 'declared' | 'missing' | 'unsupported';
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LABEL = /^[A-Za-z0-9:_./-]{1,128}$/;

/**
 * Lower an exact Skill revision's already-solved ecosystem receipts to the
 * shared package lock contract. Each segment keeps its ecosystem and scope,
 * so equal package names in separate environments never become substitutes.
 */
export function lowerSkillDependencies(request: HubDependencyRequest, requirements: HubRequirementBinding[]): {
  request: PackageLockRequest;
  subject: { revision: string; requirementMappings: Array<{ requirementOrdinal: number; segmentOrdinal: number }> };
} {
  if (request.profile !== 'hub-dependency-lock-v1' || !UUID.test(request.revision)
    || !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/i.test(request.actingSubject)
    || !Array.isArray(request.segments) || request.segments.length < 1 || request.segments.length > 16
    || !Array.isArray(requirements) || requirements.length > 256
    || request.segments.reduce((sum, item) => sum + (Array.isArray(item.requirements)
      ? item.requirements.length : 257), 0) > 256) {
    throw new HubDependencyInvalid('Skill dependency request is malformed');
  }
  const requirementsByOrdinal = new Map(requirements.map(item => [item.ordinal, item]));
  if (requirementsByOrdinal.size !== requirements.length) {
    throw new HubDependencyInvalid('Skill requirement inventory has duplicate ordinals');
  }
  const seenScopes = new Set<string>();
  const mappings: Array<{ requirementOrdinal: number; segmentOrdinal: number }> = [];
  const mapped = new Set<number>();
  const segments = request.segments.map((segment, segmentOrdinal) => {
    if (!['npm', 'cargo', 'go'].includes(segment.ecosystem) || !UUID.test(segment.resolution)
      || !['process', 'path', 'abi'].includes(segment.scope.kind) || !LABEL.test(segment.scope.label)
      || !Array.isArray(segment.requirements) || segment.requirements.length > 256) {
      throw new HubDependencyInvalid('Skill dependency segment is malformed');
    }
    const identity = `${segment.scope.kind}:${segment.scope.label}`;
    if (seenScopes.has(identity)) throw new HubDependencyInvalid('Skill dependency scopes must be unique');
    seenScopes.add(identity);
    for (const ordinal of segment.requirements) {
      const requirement = requirementsByOrdinal.get(ordinal);
      if (!Number.isInteger(ordinal) || !requirement || requirement.declaration !== 'declared'
        || requirement.ecosystem !== segment.ecosystem || mapped.has(ordinal)) {
        throw new HubDependencyInvalid('Skill requirement mapping differs from its declared ecosystem');
      }
      mapped.add(ordinal);
      mappings.push({ requirementOrdinal: ordinal, segmentOrdinal });
    }
    return { ecosystem: segment.ecosystem, resolution: segment.resolution,
      scope: { kind: segment.scope.kind, label: segment.scope.label } };
  });
  if (mappings.length > 256 || requirements.some(item => item.strength === 'required'
    && (item.declaration !== 'declared' || !['npm', 'cargo', 'go'].includes(item.ecosystem)
      || !mapped.has(item.ordinal)))) {
    throw new HubDependencyInvalid('Skill has a required dependency without a supported lock mapping');
  }
  return { request: { profile: 'rezics-package-lock-v1', segments },
    subject: { revision: request.revision, requirementMappings: mappings } };
}
