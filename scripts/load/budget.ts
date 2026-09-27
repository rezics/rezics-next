/** The measured 10k seed took 166 minutes before mix and restart checks. */
export const PRACTICAL_PROFILE_TIMEOUT_MS = 4 * 60 * 60_000;

/** Business entities/documents, not triples or rows in each owner store. */
export const CAPACITY_SCENARIOS = {
  current: 500_000_000n,
  future: 3_000_000_000n,
} as const;

/** A physical byte estimate is unavailable until RDF bytes per fact are measured. */
export interface CapacityInputs {
  ownerEntities: bigint;
  currentFactsPerEntity: bigint;
  retainedFacts: bigint;
  measuredRdfBytesPerFact: bigint | null;
  arrivalsPerSecond: bigint;
  retentionSeconds: bigint;
}

export function deriveCapacity(input: CapacityInputs) {
  for (const [name, value] of Object.entries(input)) {
    if (value !== null && value < 0n) throw new Error(`${name} must be nonnegative`);
  }
  const currentFacts = input.ownerEntities * input.currentFactsPerEntity;
  const rdfFacts = currentFacts + input.retainedFacts;
  return {
    currentFacts,
    rdfFacts,
    rdfBytes: input.measuredRdfBytesPerFact === null ? null : rdfFacts * input.measuredRdfBytesPerFact,
    retainedQueueItems: input.arrivalsPerSecond * input.retentionSeconds,
  };
}

/** Required independent axes for owner-specific workload fixtures. Values are
 * counts, depths, bytes or rates supplied by a fixture; this declares no pass
 * or production capacity for an owner without measured physical work. */
export const OWNER_WORKLOAD_DIMENSIONS = {
  catalogEditorial: ['names', 'identifiers', 'observations', 'repeatedChildren',
    'humanControlEpochs', 'sourceRefreshes', 'hotOwnerChildren'],
  governanceDelivery: ['seats', 'representativesPerSeat', 'seatsPerOperator',
    'allocationLeaves', 'concurrentReplacements', 'recipients', 'retryAttempts'],
  identityAccess: ['representationDepth', 'groupDepth', 'resourceDepth',
    'dependentGrantDepth', 'reachedStates', 'reachedEdges', 'subjectMemberships',
    'policyIntersections', 'policyExclusions', 'revocationFanout'],
  semanticInteroperability: ['sourceObjects', 'sourceFacts', 'sourceBytes',
    'lexicalResiduals', 'overlappingStreams', 'exportGenerations', 'rebuildBytes'],
  statements: ['qualifiedFacts', 'independentSupports', 'correlatedOccurrences',
    'sharedContexts', 'contextConsumers', 'overlappingGroups', 'criterionVariants',
    'semanticRevisions', 'preferenceRevisions'],
  subscriptions: ['plans', 'overlappingGrants', 'reservations', 'settlementCallbacks',
    'reviewJobs', 'publicationCandidates'],
  temporal: ['raters', 'observationCadence', 'correctionChurn', 'slotChurn',
    'intervalDensity', 'histogramBuckets'],
} as const;

export type WorkloadOwner = keyof typeof OWNER_WORKLOAD_DIMENSIONS;
export type OwnerWorkloadInput<O extends WorkloadOwner> =
  Record<(typeof OWNER_WORKLOAD_DIMENSIONS)[O][number], number>;

/** Reject an incomplete or invalid fixture before it is treated as workload evidence. */
export function checkedOwnerWorkload<O extends WorkloadOwner>(owner: O,
  dimensions: OwnerWorkloadInput<O>): OwnerWorkloadInput<O> {
  for (const name of OWNER_WORKLOAD_DIMENSIONS[owner]) {
    const value = (dimensions as Record<string, number>)[name];
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${owner}.${name} must be a nonnegative safe integer`);
    }
  }
  return dimensions;
}
