import type {
  PrivacyReductionObservationRequest,
  PublicFilterCost,
  PublicFilterSourceFactory,
} from './public-filter-source-contract.ts';

/** Native preparation input. Registration and retained capture must be resolved by their owners. */
export type FacetPopulationRequest = Readonly<{
  population: string;
  /** Opaque retained frontier; never a serialized population, head vector or permission. */
  frontier: string | null;
  /** 1..1000 examined keys, including rejects, rereads and lookahead; lower native caps still apply. */
  inputLimit: number;
  capture: Extract<PrivacyReductionObservationRequest, { kind: 'population' }>;
}>;

export type FacetPopulationPage =
  | Readonly<{
      status: 'progress' | 'complete';
      /** Retained finite population/window locator, never public disclosure evidence. */
      observation: string;
      subjects: readonly Readonly<{ partition: number; subject: string }>[];
      frontier: string;
      cost: PublicFilterCost;
    }>
  | Readonly<{ status: 'changed' | 'unready' | 'unavailable'; cost: PublicFilterCost }>;

export type ReadFacetPopulationPage = (request: FacetPopulationRequest) => Promise<FacetPopulationPage>;
export type FacetPopulationSource = Readonly<{ readFacetPopulationPage: ReadFacetPopulationPage }>;

/** Native preparation factory; producer availability is validated on every retained step. */
export type FacetPopulationSourceFactory = (config: Parameters<PublicFilterSourceFactory>[0]) => FacetPopulationSource;
