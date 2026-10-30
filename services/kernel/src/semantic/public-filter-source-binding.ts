import type { CustodyDefinition } from '../search/public-filter-custody-contract.ts';
import type {
  PublicCanonicalCaptureInput,
  PublicFilterConsumerContext,
  PublicFilterConsumerUnavailable,
  PublicFilterQueriedObservation,
} from '../search/public-filter-consumer-contract.ts';
import type {
  PrivacyReductionObservation,
  PrivacyReductionObservationRequest,
  PublicFilterCost,
  PublicFilterProjectionMeaning,
  PublicFilterSource,
} from './public-filter-source-contract.ts';

/** Agreed additive native binding handoff. The Source producer owns all implementation. */
export type JoinedPopulationRequest =
  | Readonly<{ kind: 'queried'; phase: 'start' | 'status'; queried: PublicFilterQueriedObservation }>
  | Readonly<{
      kind: 'queried';
      phase: 'final';
      queried: PublicFilterQueriedObservation;
      execution: string;
    }>;

export interface PublicFilterNativeSource extends PublicFilterSource {
  resolvePublicFilterDefinition(
    request: Readonly<{ meaning: PublicFilterProjectionMeaning; capture: PublicCanonicalCaptureInput }>,
    context: PublicFilterConsumerContext,
  ): Promise<
    | Readonly<{ status: 'bound'; definition: CustodyDefinition<PublicCanonicalCaptureInput>; cost: PublicFilterCost }>
    | PublicFilterConsumerUnavailable
  >;
  readPrivacyReductionHeads(request: PrivacyReductionObservationRequest): Promise<PrivacyReductionObservation>;
  readPrivacyReductionHeads(
    request: JoinedPopulationRequest,
    context: PublicFilterConsumerContext,
  ): Promise<PrivacyReductionObservation>;
}
