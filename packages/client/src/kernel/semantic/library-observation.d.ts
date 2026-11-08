/** Semantic application for canonical, Follow and shelf observation consumers. */
import type { LibrarySemanticObservationCapability } from '../library/contract/semantic-observation.ts';
import { type SemanticObservationNativeAdapter } from './adapters/library-observation.ts';
/** Attach each native result to the exact owner declaration for that operation. */
export declare function createLibraryObservationApplication(native?: SemanticObservationNativeAdapter): LibrarySemanticObservationCapability;
