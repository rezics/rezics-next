/** Installed Semantic observations as consumed by Library's bounded plans. */

import { declareBound, type Bound } from '@rezics/bounds';
import { peekLibraryDomain, requireLibraryPresentation } from './domain-binding.ts';
import type { LibrarySemanticObservationCapability, WorkDimensions, WorkReceipt } from './contract/index.ts';

/** Resolve the same immutable capability installed by production composition. */
export function librarySemanticObservations(): LibrarySemanticObservationCapability {
  return peekLibraryDomain()?.semanticObservations ?? requireLibraryPresentation().semanticObservations;
}

/** Translate an owner declaration without adding a funding axis or native authority. */
export function semanticObservationBound(work: WorkDimensions): Bound {
  return declareBound({ ...work, engineRequests: 0 });
}

export function semanticObservationReceipt(work: WorkDimensions, reservationId: string): WorkReceipt {
  return Object.freeze({ reservationId, used: Object.freeze({ ...work }) });
}
