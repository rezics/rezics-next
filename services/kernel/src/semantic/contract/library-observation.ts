/** Public contract for the Semantic observation provider installed for Library. */

export type {
  LibrarySemanticMapping,
  LibrarySemanticObservationCapability,
  LibrarySemanticObservationResult,
  LibrarySemanticScopeKey,
  LibrarySemanticScopeObservation,
  LibrarySemanticScopeRegistration,
  LibrarySemanticScopeResult,
  LibrarySemanticScopeRevalidation,
  LibrarySemanticSummaryContext,
  LibrarySemanticSummaryObservation,
} from '../../library/contract/semantic-observation.ts';

import type { LibrarySemanticObservationCapability } from '../../library/contract/semantic-observation.ts';

/** Semantic's complete Library observation surface. The capability is supplied by composition. */
export type LibraryObservationProvider = LibrarySemanticObservationCapability;
