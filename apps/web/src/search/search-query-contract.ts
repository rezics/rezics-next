import type { FilterDocument, FilterRange } from '@rezics/filter';
import type { SearchLoaderDeps } from './search-params';
import type { SearchResourceScope } from './advanced-scope';
import type { ConditionMetadata, SearchProblem } from './condition-editor-model';
import type { DiscoveryState, LegacySearchPage } from './discovery';
import type { SearchRecoveryState } from './search-recovery';
import type { ResourceLanguageRefinement } from './language-refinement';
import type { RefinementApplicability, RefinementData } from './refinement/model';
import type { RealmRatingPopulationOption, RealmRatingReadiness } from './rating-population';

export type SearchFacetValueLabel = { text: string; lang?: string };

/** Validated input accepted by the Search application after the server adapter parses its request. */
export type SearchRequestParams = {
  query: string;
  locale: string;
  cursor?: string | undefined;
  sort?: 'rating' | undefined;
  type?: string | undefined;
  kinds?: string[] | undefined;
  languages?: string[] | undefined;
  filter?: string | undefined;
  resourceScope?: SearchResourceScope | undefined;
  ratingPopulation?: string | undefined;
  representation?: 'subjects-v1';
  kindCursor?: string;
  reader?: string | undefined;
  facetValues: Record<string, string[]>;
  ranges?: Record<string, FilterRange>;
  condition?: FilterDocument | undefined;
};

export type SearchPageData = {
  recovery?: SearchRecoveryState;
  conditionMetadata?: ConditionMetadata;
  problem?: SearchProblem;
  queryState?: SearchLoaderDeps;
  refinement?: RefinementData;
  resourceLanguage?: ResourceLanguageRefinement;
  ranges?: Record<string, FilterRange>;
  condition?: FilterDocument | undefined;
  result?: LegacySearchPage;
  discovery?: DiscoveryState;
  refinementApplicability?: RefinementApplicability;
  type?: string | undefined;
  typeLabels?: Record<string, string>;
  hitTypes: Record<string, Record<string, string>>;
  /** The properties whose time values give a hit its year, in the order the search asked for them. */
  yearProperties: string[];
  typeChoices: { id: string; labels: Record<string, string> }[];
  groups: {
    property: string;
    labels: Record<string, string>;
    values: {
      value: string;
      labels: Record<string, string>;
      parentTypeLabels?: Record<string, string>;
    }[];
  }[];
  selectedFacets: Record<string, string[]>;
  selectedFacetLabels: Record<string, Record<string, SearchFacetValueLabel>>;
  facetsAvailable: boolean;
  facetRetry: boolean;
  facetIndexNotReady: boolean;
  staleCursorRestarted: boolean;
  sort: 'relevance' | 'rating';
  ratingPopulation?: string;
  ratingPopulations?: readonly RealmRatingPopulationOption[];
  ratingReadiness?: RealmRatingReadiness;
};

export type SearchApplicationReader = Readonly<{
  owner: string;
  authorization?: string;
}>;

export type SearchApplicationContext = Readonly<{
  signal: AbortSignal;
  reader?: SearchApplicationReader;
}>;

/** The consumer-facing Search operation; transport and session resolution are supplied by the adapter. */
export type SearchApplication = Readonly<{
  read(data: SearchRequestParams, context: SearchApplicationContext): Promise<SearchPageData>;
  queryKey(locale: string, params: SearchLoaderDeps, reader?: string): readonly ['search', 'discovery-v1', string];
  loadingPage(params: SearchLoaderDeps): SearchPageData;
  unavailablePage(params: SearchLoaderDeps): SearchPageData;
}>;
