import type { SpaceDiscoveryDependencyReadiness } from '../community/index.ts';
import { DiscoveryProducerCoverageError } from './discovery-errors.ts';
import type { DiscoveryMetadataKind, DiscoveryMetadataProducers } from './discovery-api.ts';

export type DiscoveryCapabilityWitnesses = Readonly<
  Record<string, Extract<SpaceDiscoveryDependencyReadiness, { state: 'ready' }>>
>;
export type DiscoveryProducerOmission = Readonly<{
  kind: DiscoveryMetadataKind;
  state: 'preparing' | 'unavailable';
}>;

/** Required public metadata kinds for a complete second-scope discovery generation. */
export const SECOND_SCOPE_PUBLIC_METADATA_KINDS = Object.freeze(['collection', 'review', 'space'] as const);

/** Classify each native metadata producer without turning one absent source into global unavailability. */
export async function classifyDiscoveryMetadataProducers(producers: DiscoveryMetadataProducers): Promise<{
  availableKinds: DiscoveryMetadataKind[];
  omittedKinds: DiscoveryProducerOmission[];
  witnesses: DiscoveryCapabilityWitnesses;
}> {
  const witnesses: Record<string, Extract<SpaceDiscoveryDependencyReadiness, { state: 'ready' }>> = {};
  const availableKinds: DiscoveryMetadataKind[] = [];
  const omittedKinds: DiscoveryProducerOmission[] = [];
  for (const kind of SECOND_SCOPE_PUBLIC_METADATA_KINDS) {
    const producer = producers[kind];
    if (!producer) {
      omittedKinds.push({ kind, state: 'unavailable' });
      continue;
    }
    const readiness = await producer.readiness();
    if (kind === 'space' && readiness === 'ready')
      throw new DiscoveryProducerCoverageError({ missingKinds: [], unsupportedKinds: [kind], duplicateKinds: [] });
    const state = typeof readiness === 'string' ? readiness : readiness.state;
    if (state !== 'ready') {
      omittedKinds.push({ kind, state });
      continue;
    }
    if (typeof readiness !== 'string') {
      if (readiness.state !== 'ready' || !readiness.generation || !readiness.cut)
        throw new TypeError('Native discovery capability has no generation/cut witness');
      witnesses[kind] = structuredClone(readiness);
    }
    availableKinds.push(kind);
  }
  return { availableKinds, omittedKinds, witnesses };
}

/** Preserve the native witness verbatim; neither a position nor adapter installation is an epoch. */
export async function discoveryCapabilityWitnesses(producers: DiscoveryMetadataProducers) {
  const classification = await classifyDiscoveryMetadataProducers(producers);
  const unavailable = classification.omittedKinds
    .filter(({ kind }) => producers[kind] !== undefined)
    .map(({ kind }) => kind);
  if (unavailable.length)
    throw new DiscoveryProducerCoverageError({ missingKinds: [], unsupportedKinds: unavailable, duplicateKinds: [] });
  return classification.witnesses;
}
