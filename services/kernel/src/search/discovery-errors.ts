import type { DiscoveryMetadataKind } from './discovery-api.ts';

/** A candidate cannot be populated or published from an incomplete native producer set. */
export class DiscoveryProducerCoverageError extends Error {
  readonly missingKinds: readonly string[];
  readonly unsupportedKinds: readonly string[];
  readonly duplicateKinds: readonly string[];

  constructor(input: {
    missingKinds: readonly string[];
    unsupportedKinds: readonly string[];
    duplicateKinds: readonly string[];
  }) {
    const details = [
      ...(input.missingKinds.length ? [`missing kinds: ${input.missingKinds.join(', ')}`] : []),
      ...(input.unsupportedKinds.length ? [`unsupported kinds: ${input.unsupportedKinds.join(', ')}`] : []),
      ...(input.duplicateKinds.length ? [`duplicate kinds: ${input.duplicateKinds.join(', ')}`] : []),
    ];
    const message = 'Discovery generation is not ready: native producer coverage is incomplete';
    super(details.length ? `${message} (${details.join('; ')})` : message);
    this.name = 'DiscoveryProducerCoverageError';
    this.missingKinds = input.missingKinds;
    this.unsupportedKinds = input.unsupportedKinds;
    this.duplicateKinds = input.duplicateKinds;
  }
}

/** A signed owner continuation was invalidated; never retry its retired cut forever. */
export class DiscoveryPopulationCutChangedError extends DiscoveryProducerCoverageError {
  constructor(kind: DiscoveryMetadataKind) {
    super({ missingKinds: [], unsupportedKinds: [kind], duplicateKinds: [] });
  }
}
